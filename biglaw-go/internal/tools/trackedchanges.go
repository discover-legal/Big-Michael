// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

// DOCX tracked-changes engine + edit_document tool. Ported from
// src/tools/docx-tracked-changes.ts (itself ported from Mike, AGPL-3.0).
//
// applyTrackedEdits rewrites a .docx so that requested substitutions appear
// as <w:ins>/<w:del> tracked changes (with author/date attributes) rather
// than direct text replacements. Only text inside <w:p><w:r><w:t> is
// considered; headers, footers, comments and footnotes are left alone.
// Pre-existing tracked changes are presented to the matcher in *accepted
// view*: w:ins runs are treated as normal text, w:del wrappers are invisible.
// When a new edit's range lands on runs inside a pre-existing w:ins, the
// wrapper is dropped (accepting that insertion) before the new change is
// emitted.
//
// The XML layer is a tiny order-preserving parser/serializer (no external
// dependency) that keeps prefixed names (w:p, w:r, …) verbatim — Go's
// encoding/xml cannot round-trip OOXML namespaces faithfully.

package tools

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/discover-legal/biglaw-go/internal/agents"
	"github.com/discover-legal/biglaw-go/internal/providers"
)

// ─── Public types ─────────────────────────────────────────────────────────────

// EditInput is one requested substitution, anchored by surrounding context.
type EditInput struct {
	Find          string
	Replace       string
	ContextBefore string
	ContextAfter  string
	Reason        string
}

// AppliedChange describes one tracked change written into the document.
type AppliedChange struct {
	ID            string `json:"id"`
	DelID         string `json:"delId,omitempty"`
	InsID         string `json:"insId,omitempty"`
	DeletedText   string `json:"deletedText"`
	InsertedText  string `json:"insertedText"`
	ContextBefore string `json:"contextBefore"`
	ContextAfter  string `json:"contextAfter"`
	Reason        string `json:"reason,omitempty"`
}

// EditError reports why one requested edit could not be applied.
type EditError struct {
	Index  int    `json:"index"`
	Reason string `json:"reason"`
}

// ─── Minimal order-preserving XML tree ────────────────────────────────────────

type xmlAttr struct {
	Name  string
	Value string
}

// xmlNode: Name == "" means a text node (Text holds the decoded content);
// Name == "#raw" preserves comments/PIs/DOCTYPE verbatim in Text.
type xmlNode struct {
	Name     string
	Attrs    []xmlAttr
	Children []*xmlNode
	Text     string
}

func (n *xmlNode) attr(name string) (string, bool) {
	for _, a := range n.Attrs {
		if a.Name == name {
			return a.Value, true
		}
	}
	return "", false
}

func makeEl(name string, children []*xmlNode, attrs []xmlAttr) *xmlNode {
	return &xmlNode{Name: name, Children: children, Attrs: attrs}
}

func makeText(s string) *xmlNode { return &xmlNode{Text: s} }

func cloneNode(n *xmlNode) *xmlNode {
	if n == nil {
		return nil
	}
	out := &xmlNode{Name: n.Name, Text: n.Text}
	if len(n.Attrs) > 0 {
		out.Attrs = append([]xmlAttr(nil), n.Attrs...)
	}
	for _, c := range n.Children {
		out.Children = append(out.Children, cloneNode(c))
	}
	return out
}

// ─── XML parsing ──────────────────────────────────────────────────────────────

type xmlParser struct {
	s   string
	pos int
}

func parseXMLFragment(s string) ([]*xmlNode, error) {
	p := &xmlParser{s: s}
	nodes, closed, err := p.parseNodes("")
	if err != nil {
		return nil, err
	}
	if closed {
		return nil, fmt.Errorf("unexpected closing tag at top level")
	}
	return nodes, nil
}

func isXMLNameEnd(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '/' || c == '>'
}

func (p *xmlParser) skipSpace() {
	for p.pos < len(p.s) {
		c := p.s[p.pos]
		if c != ' ' && c != '\t' && c != '\n' && c != '\r' {
			return
		}
		p.pos++
	}
}

// parseNodes consumes children until the matching closing tag (or EOF when
// closing == ""). Returns closed=true when it consumed </closing>.
func (p *xmlParser) parseNodes(closing string) ([]*xmlNode, bool, error) {
	var out []*xmlNode
	for p.pos < len(p.s) {
		if p.s[p.pos] == '<' {
			rest := p.s[p.pos:]
			switch {
			case strings.HasPrefix(rest, "</"):
				end := strings.IndexByte(rest, '>')
				if end < 0 {
					return nil, false, fmt.Errorf("unterminated closing tag")
				}
				name := strings.TrimSpace(rest[2:end])
				p.pos += end + 1
				if name != closing {
					return nil, false, fmt.Errorf("unexpected closing tag </%s> (expected </%s>)", name, closing)
				}
				return out, true, nil
			case strings.HasPrefix(rest, "<?"):
				end := strings.Index(rest, "?>")
				if end < 0 {
					return nil, false, fmt.Errorf("unterminated processing instruction")
				}
				// XML declaration is dropped (the serializer re-emits its own);
				// other PIs are preserved verbatim.
				raw := rest[:end+2]
				if !strings.HasPrefix(raw, "<?xml") {
					out = append(out, &xmlNode{Name: "#raw", Text: raw})
				}
				p.pos += end + 2
			case strings.HasPrefix(rest, "<!--"):
				end := strings.Index(rest, "-->")
				if end < 0 {
					return nil, false, fmt.Errorf("unterminated comment")
				}
				out = append(out, &xmlNode{Name: "#raw", Text: rest[:end+3]})
				p.pos += end + 3
			case strings.HasPrefix(rest, "<![CDATA["):
				end := strings.Index(rest, "]]>")
				if end < 0 {
					return nil, false, fmt.Errorf("unterminated CDATA section")
				}
				out = append(out, makeText(rest[len("<![CDATA["):end]))
				p.pos += end + 3
			case strings.HasPrefix(rest, "<!"):
				end := strings.IndexByte(rest, '>')
				if end < 0 {
					return nil, false, fmt.Errorf("unterminated declaration")
				}
				out = append(out, &xmlNode{Name: "#raw", Text: rest[:end+1]})
				p.pos += end + 1
			default:
				node, err := p.parseElement()
				if err != nil {
					return nil, false, err
				}
				out = append(out, node)
			}
			continue
		}
		next := strings.IndexByte(p.s[p.pos:], '<')
		var raw string
		if next < 0 {
			raw = p.s[p.pos:]
			p.pos = len(p.s)
		} else {
			raw = p.s[p.pos : p.pos+next]
			p.pos += next
		}
		if raw != "" {
			out = append(out, makeText(decodeXMLEntities(raw)))
		}
	}
	if closing != "" {
		return nil, false, fmt.Errorf("missing closing tag </%s>", closing)
	}
	return out, false, nil
}

func (p *xmlParser) parseElement() (*xmlNode, error) {
	p.pos++ // consume '<'
	nameStart := p.pos
	for p.pos < len(p.s) && !isXMLNameEnd(p.s[p.pos]) {
		p.pos++
	}
	if p.pos == nameStart {
		return nil, fmt.Errorf("empty element name at offset %d", p.pos)
	}
	node := &xmlNode{Name: p.s[nameStart:p.pos]}

	for {
		p.skipSpace()
		if p.pos >= len(p.s) {
			return nil, fmt.Errorf("unterminated element <%s>", node.Name)
		}
		c := p.s[p.pos]
		if c == '/' {
			if p.pos+1 < len(p.s) && p.s[p.pos+1] == '>' {
				p.pos += 2
				return node, nil // self-closing
			}
			return nil, fmt.Errorf("malformed tag <%s>", node.Name)
		}
		if c == '>' {
			p.pos++
			break
		}
		// attribute
		aStart := p.pos
		for p.pos < len(p.s) && p.s[p.pos] != '=' && !isXMLNameEnd(p.s[p.pos]) {
			p.pos++
		}
		aName := p.s[aStart:p.pos]
		p.skipSpace()
		if p.pos >= len(p.s) || p.s[p.pos] != '=' {
			return nil, fmt.Errorf("attribute %q in <%s> has no value", aName, node.Name)
		}
		p.pos++ // '='
		p.skipSpace()
		if p.pos >= len(p.s) || (p.s[p.pos] != '"' && p.s[p.pos] != '\'') {
			return nil, fmt.Errorf("attribute %q in <%s> has unquoted value", aName, node.Name)
		}
		quote := p.s[p.pos]
		p.pos++
		vStart := p.pos
		for p.pos < len(p.s) && p.s[p.pos] != quote {
			p.pos++
		}
		if p.pos >= len(p.s) {
			return nil, fmt.Errorf("unterminated attribute value in <%s>", node.Name)
		}
		node.Attrs = append(node.Attrs, xmlAttr{Name: aName, Value: decodeXMLEntities(p.s[vStart:p.pos])})
		p.pos++ // closing quote
	}

	children, closed, err := p.parseNodes(node.Name)
	if err != nil {
		return nil, err
	}
	if !closed {
		return nil, fmt.Errorf("missing closing tag </%s>", node.Name)
	}
	node.Children = children
	return node, nil
}

func decodeXMLEntities(s string) string {
	if !strings.Contains(s, "&") {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		if s[i] != '&' {
			b.WriteByte(s[i])
			i++
			continue
		}
		semi := strings.IndexByte(s[i:], ';')
		if semi < 0 || semi > 10 {
			b.WriteByte('&')
			i++
			continue
		}
		ent := s[i+1 : i+semi]
		switch {
		case ent == "amp":
			b.WriteByte('&')
		case ent == "lt":
			b.WriteByte('<')
		case ent == "gt":
			b.WriteByte('>')
		case ent == "quot":
			b.WriteByte('"')
		case ent == "apos":
			b.WriteByte('\'')
		case strings.HasPrefix(ent, "#x") || strings.HasPrefix(ent, "#X"):
			if v, err := strconv.ParseInt(ent[2:], 16, 32); err == nil {
				b.WriteRune(rune(v))
			} else {
				b.WriteString(s[i : i+semi+1])
			}
		case strings.HasPrefix(ent, "#"):
			if v, err := strconv.ParseInt(ent[1:], 10, 32); err == nil {
				b.WriteRune(rune(v))
			} else {
				b.WriteString(s[i : i+semi+1])
			}
		default:
			b.WriteString(s[i : i+semi+1])
		}
		i += semi + 1
	}
	return b.String()
}

var xmlTextEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
var xmlAttrEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")

func writeXMLNode(b *strings.Builder, n *xmlNode) {
	switch n.Name {
	case "":
		b.WriteString(xmlTextEscaper.Replace(n.Text))
	case "#raw":
		b.WriteString(n.Text)
	default:
		b.WriteString("<" + n.Name)
		for _, a := range n.Attrs {
			b.WriteString(" " + a.Name + `="` + xmlAttrEscaper.Replace(a.Value) + `"`)
		}
		if len(n.Children) == 0 {
			b.WriteString("/>")
			return
		}
		b.WriteString(">")
		for _, c := range n.Children {
			writeXMLNode(b, c)
		}
		b.WriteString("</" + n.Name + ">")
	}
}

func serializeXML(nodes []*xmlNode) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` + "\n")
	for _, n := range nodes {
		writeXMLNode(&b, n)
	}
	return b.String()
}

// ─── Paragraph flattening ─────────────────────────────────────────────────────

type tcTextNode struct {
	wtEl      *xmlNode
	text      []rune
	paraStart int
	paraEnd   int
}

type tcRunSlot struct {
	childIndex int      // index in paragraph children
	rPr        *xmlNode // reference (not cloned)
	textNodes  []tcTextNode
}

type tcFlattened struct {
	paraText     []rune
	charRun      []int // rune index → run slot index
	charTextNode []int // rune index → index into slot.textNodes
	charOffset   []int // rune index → offset within that text node
	runs         []tcRunSlot
}

func wtTextContent(wtEl *xmlNode) string {
	var out strings.Builder
	for _, k := range wtEl.Children {
		if k.Name == "" {
			out.WriteString(k.Text)
		}
	}
	return out.String()
}

func flattenParagraph(paraChildren []*xmlNode) *tcFlattened {
	flat := &tcFlattened{}

	processRun := func(rEl *xmlNode, topChildIdx int) {
		var rPr *xmlNode
		var textNodes []tcTextNode
		runIdx := len(flat.runs)
		for _, rk := range rEl.Children {
			switch rk.Name {
			case "w:rPr":
				rPr = rk
			case "w:t":
				txt := []rune(wtTextContent(rk))
				start := len(flat.paraText)
				textNodes = append(textNodes, tcTextNode{
					wtEl:      rk,
					text:      txt,
					paraStart: start,
					paraEnd:   start + len(txt),
				})
				tnIdx := len(textNodes) - 1
				flat.paraText = append(flat.paraText, txt...)
				for i := range txt {
					flat.charRun = append(flat.charRun, runIdx)
					flat.charTextNode = append(flat.charTextNode, tnIdx)
					flat.charOffset = append(flat.charOffset, i)
				}
			}
			// other run children (w:tab, w:br, w:sym, …) are left alone
		}
		flat.runs = append(flat.runs, tcRunSlot{childIndex: topChildIdx, rPr: rPr, textNodes: textNodes})
	}

	for ci, child := range paraChildren {
		switch child.Name {
		case "w:r":
			processRun(child, ci)
		case "w:ins":
			// Accepted view: include inner runs as if bare. childIndex points
			// at the w:ins wrapper so reconstruction can drop the wrapper
			// whole when a new edit touches any of these runs.
			for _, inner := range child.Children {
				if inner.Name == "w:r" {
					processRun(inner, ci)
				}
			}
		}
		// w:del: skip entirely — accepted view excludes deleted text.
	}
	return flat
}

// ─── Diff collapse ────────────────────────────────────────────────────────────

// collapseDiff strips the leading/trailing common substrings of find/replace
// so the tracked range is minimal — one "replace this with that" card.
func collapseDiff(find, replace []rune) (deleted, inserted []rune, leadingEq int) {
	minLen := len(find)
	if len(replace) < minLen {
		minLen = len(replace)
	}
	leading := 0
	for leading < minLen && find[leading] == replace[leading] {
		leading++
	}
	trailing := 0
	for trailing < minLen-leading &&
		find[len(find)-1-trailing] == replace[len(replace)-1-trailing] {
		trailing++
	}
	return find[leading : len(find)-trailing], replace[leading : len(replace)-trailing], leading
}

// ─── Planned changes ──────────────────────────────────────────────────────────

type plannedChange struct {
	editIndex     int
	deleteStart   int // paragraph rune offset (inclusive)
	deleteEnd     int // paragraph rune offset (exclusive); may equal start
	deletedText   string
	insertedText  string
	contextBefore string
	contextAfter  string
	reason        string
	changeID      string
	delWID        string // w:id of w:del wrapper ("" when no deletion)
	insWID        string // w:id of w:ins wrapper ("" when no insertion)
}

// buildTrackedRun wraps a piece of text in a w:r. Newlines are emitted as
// <w:br/> soft line breaks (interleaved with w:t/w:delText segments) so models
// can request multi-line replacements without a literal "\n" showing as text.
func buildTrackedRun(rPr *xmlNode, text string, tagName string) *xmlNode {
	var children []*xmlNode
	if rPr != nil {
		children = append(children, cloneNode(rPr))
	}
	for i, seg := range strings.Split(text, "\n") {
		if i > 0 {
			children = append(children, makeEl("w:br", nil, nil))
		}
		if len(seg) > 0 {
			children = append(children, makeEl(tagName,
				[]*xmlNode{makeText(seg)},
				[]xmlAttr{{Name: "xml:space", Value: "preserve"}}))
		}
	}
	return makeEl("w:r", children, nil)
}

// ─── Paragraph reconstruction ─────────────────────────────────────────────────

// reconstructParagraph returns a new children slice with the sorted,
// non-overlapping planned changes inserted as <w:ins>/<w:del> wrappers.
func reconstructParagraph(paraChildren []*xmlNode, flat *tcFlattened, plan []*plannedChange, now, author string) []*xmlNode {
	if len(plan) == 0 {
		return paraChildren
	}

	// Determine the run-index span that edits touch.
	firstRunIdx := len(flat.runs)
	lastRunIdx := -1
	touch := func(r int) {
		if r < firstRunIdx {
			firstRunIdx = r
		}
		if r > lastRunIdx {
			lastRunIdx = r
		}
	}
	for _, p := range plan {
		for pos := p.deleteStart; pos < p.deleteEnd; pos++ {
			touch(flat.charRun[pos])
		}
		// Also include the run to the left/right of a pure insertion so we
		// can inherit its rPr.
		if p.deleteStart == p.deleteEnd && p.deleteStart < len(flat.paraText) {
			touch(flat.charRun[p.deleteStart])
		} else if p.deleteStart == p.deleteEnd && p.deleteStart > 0 {
			touch(flat.charRun[p.deleteStart-1])
		}
	}
	if firstRunIdx > lastRunIdx {
		// No runs touched (edits against an empty paragraph) — nothing to do.
		return paraChildren
	}

	startChildIdx := flat.runs[firstRunIdx].childIndex
	endChildIdx := flat.runs[lastRunIdx].childIndex

	firstRun := flat.runs[firstRunIdx]
	lastRun := flat.runs[lastRunIdx]
	spanStart := 0
	if len(firstRun.textNodes) > 0 {
		spanStart = firstRun.textNodes[0].paraStart
	}
	spanEnd := spanStart
	if len(lastRun.textNodes) > 0 {
		spanEnd = lastRun.textNodes[len(lastRun.textNodes)-1].paraEnd
	}

	var newRunGroup []*xmlNode

	// rPr for the run containing paragraph offset pos (clamped) — used to
	// inherit formatting for insertions on a boundary.
	rPrForPos := func(pos int) *xmlNode {
		if pos < 0 {
			pos = 0
		}
		if pos >= len(flat.paraText) {
			pos = len(flat.paraText) - 1
		}
		if pos < 0 {
			return firstRun.rPr
		}
		return flat.runs[flat.charRun[pos]].rPr
	}

	// Emit a "normal" run fragment covering [a, b), grouping consecutive
	// chars belonging to the same source text node.
	emitNormal := func(a, b int) {
		for i := a; i < b; {
			runIdx := flat.charRun[i]
			tnIdx := flat.charTextNode[i]
			j := i + 1
			for j < b && flat.charRun[j] == runIdx && flat.charTextNode[j] == tnIdx {
				j++
			}
			newRunGroup = append(newRunGroup,
				buildTrackedRun(flat.runs[runIdx].rPr, string(flat.paraText[i:j]), "w:t"))
			i = j
		}
	}

	emitDel := func(a, b int, wID string) {
		if a >= b {
			return
		}
		var inner []*xmlNode
		for i := a; i < b; {
			runIdx := flat.charRun[i]
			tnIdx := flat.charTextNode[i]
			j := i + 1
			for j < b && flat.charRun[j] == runIdx && flat.charTextNode[j] == tnIdx {
				j++
			}
			inner = append(inner,
				buildTrackedRun(flat.runs[runIdx].rPr, string(flat.paraText[i:j]), "w:delText"))
			i = j
		}
		newRunGroup = append(newRunGroup, makeEl("w:del", inner, []xmlAttr{
			{Name: "w:id", Value: wID},
			{Name: "w:author", Value: author},
			{Name: "w:date", Value: now},
		}))
	}

	emitIns := func(pos int, text, wID string) {
		if text == "" {
			return
		}
		p := pos
		if p == spanEnd {
			p = pos - 1
		}
		run := buildTrackedRun(rPrForPos(p), text, "w:t")
		newRunGroup = append(newRunGroup, makeEl("w:ins", []*xmlNode{run}, []xmlAttr{
			{Name: "w:id", Value: wID},
			{Name: "w:author", Value: author},
			{Name: "w:date", Value: now},
		}))
	}

	cursor := spanStart
	for _, p := range plan {
		emitNormal(cursor, p.deleteStart)
		if p.insertedText != "" {
			emitIns(p.deleteStart, p.insertedText, p.insWID)
		}
		if p.deleteEnd > p.deleteStart {
			emitDel(p.deleteStart, p.deleteEnd, p.delWID)
		}
		cursor = p.deleteEnd
	}
	emitNormal(cursor, spanEnd)

	// Replace only the w:r children the edits touch; preserve other
	// interleaved elements (bookmarks, existing tracked changes, w:sdt …).
	dropped := map[int]bool{}
	for r := firstRunIdx; r <= lastRunIdx; r++ {
		dropped[flat.runs[r].childIndex] = true
	}
	// w:del wrappers inside the rewritten span are also dropped, which
	// accepts their deletions (their text is already absent in accepted view).
	for i := startChildIdx; i <= endChildIdx; i++ {
		if paraChildren[i].Name == "w:del" {
			dropped[i] = true
		}
	}
	out := make([]*xmlNode, 0, len(paraChildren)+len(newRunGroup))
	for i, child := range paraChildren {
		if i == startChildIdx {
			out = append(out, newRunGroup...)
		}
		if dropped[i] {
			continue
		}
		out = append(out, child)
	}
	return out
}

// ─── Whitespace / punctuation normalization for anchor matching ──────────────
// The text LLMs see does not line up 1:1 with the raw w:t concatenation:
// smart quotes, non-breaking spaces, tabs, and runs of whitespace all differ.
// Both haystack and needle are normalized to a canonical form for matching;
// matched offsets are then mapped back to the original paragraph text.

func preNormalizeRune(r rune) rune {
	switch r {
	case '\u2018', '\u2019', '\u2032': // smart single quotes, prime
		return '\''
	case '\u201C', '\u201D', '\u2033': // smart double quotes, double prime
		return '"'
	case '\u2013', '\u2014': // en/em dash
		return '-'
	case '\u00A0', '\u200B': // non-breaking space, zero-width space
		return ' '
	}
	return r
}

type tcNormalized struct {
	norm    []rune
	origIdx []int // origIdx[i] = rune index in the original string for norm[i]
}

func normalizeWs(input []rune) tcNormalized {
	var n tcNormalized
	prevSpace := false
	for i, r0 := range input {
		r := preNormalizeRune(r0)
		if unicode.IsSpace(r) {
			if !prevSpace {
				n.norm = append(n.norm, ' ')
				n.origIdx = append(n.origIdx, i)
				prevSpace = true
			}
		} else {
			n.norm = append(n.norm, r)
			n.origIdx = append(n.origIdx, i)
			prevSpace = false
		}
	}
	return n
}

func runeIndex(hay, needle []rune, from int) int {
	if len(needle) == 0 {
		return -1
	}
	for i := from; i <= len(hay)-len(needle); i++ {
		match := true
		for j := range needle {
			if hay[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

func runesEqual(a, b []rune) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// findUniqueAnchor locates the unique position in hayNorm where findNorm
// appears AND is preceded by ctxBeforeNorm AND followed by ctxAfterNorm.
// Returns errKind "none" or "ambiguous" on failure.
func findUniqueAnchor(hayNorm, findNorm, ctxBeforeNorm, ctxAfterNorm []rune) (start, end int, errKind string) {
	var candidates []int

	checkCtx := func(pos int) bool {
		if len(ctxBeforeNorm) > 0 {
			s := pos - len(ctxBeforeNorm)
			if s < 0 || !runesEqual(hayNorm[s:pos], ctxBeforeNorm) {
				return false
			}
		}
		if len(ctxAfterNorm) > 0 {
			e := pos + len(findNorm)
			if e+len(ctxAfterNorm) > len(hayNorm) || !runesEqual(hayNorm[e:e+len(ctxAfterNorm)], ctxAfterNorm) {
				return false
			}
		}
		return true
	}

	if len(findNorm) == 0 {
		// Pure insertion — scan every position.
		for i := 0; i <= len(hayNorm); i++ {
			if checkCtx(i) {
				candidates = append(candidates, i)
			}
		}
	} else {
		from := 0
		for from <= len(hayNorm)-len(findNorm) {
			idx := runeIndex(hayNorm, findNorm, from)
			if idx < 0 {
				break
			}
			if checkCtx(idx) {
				candidates = append(candidates, idx)
			}
			from = idx + 1
		}
	}

	if len(candidates) == 0 {
		return 0, 0, "none"
	}
	if len(candidates) > 1 {
		return 0, 0, "ambiguous"
	}
	return candidates[0], candidates[0] + len(findNorm), ""
}

// mapNormRangeToOriginal maps a normalized [start, end) range back to the
// original rune range.
func mapNormRangeToOriginal(n tcNormalized, origLen, normStart, normEnd int) (int, int) {
	origStart := origLen
	if normStart < len(n.origIdx) {
		origStart = n.origIdx[normStart]
	}
	origEnd := origStart
	if normEnd != normStart {
		if normEnd-1 < len(n.origIdx) {
			origEnd = n.origIdx[normEnd-1] + 1
		} else {
			origEnd = origLen
		}
	}
	return origStart, origEnd
}

// ─── Document walking ─────────────────────────────────────────────────────────

type paragraphRef struct {
	paraNode *xmlNode
	flat     *tcFlattened
}

func findBody(doc []*xmlNode) *xmlNode {
	for _, top := range doc {
		if top.Name == "w:document" {
			for _, c := range top.Children {
				if c.Name == "w:body" {
					return c
				}
			}
		}
	}
	return nil
}

func collectParagraphs(nodes []*xmlNode, out *[]paragraphRef) {
	for _, n := range nodes {
		switch n.Name {
		case "w:p":
			*out = append(*out, paragraphRef{paraNode: n, flat: flattenParagraph(n.Children)})
		case "w:tbl", "w:tr", "w:tc", "w:sdt", "w:sdtContent":
			collectParagraphs(n.Children, out)
		}
	}
}

// maxTrackedID walks the tree collecting the max w:id in w:ins/w:del so new
// changes can start their numbering safely above it.
func maxTrackedID(doc []*xmlNode) int {
	max := 0
	var visit func(n *xmlNode)
	visit = func(n *xmlNode) {
		if n.Name == "w:ins" || n.Name == "w:del" {
			if raw, ok := n.attr("w:id"); ok {
				if v, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && v > max {
					max = v
				}
			}
		}
		for _, c := range n.Children {
			visit(c)
		}
	}
	for _, top := range doc {
		visit(top)
	}
	return max
}

// ─── DOCX zip helpers ─────────────────────────────────────────────────────────

// Some older Windows/Word archives store entries with backslash separators
// (e.g. `word\document.xml`) even though the zip spec requires forward
// slashes. Lookups accept the canonical form and fall back to backslashes.
func findZipEntry(zr *zip.Reader, pathSlash string) *zip.File {
	backslash := strings.ReplaceAll(pathSlash, "/", "\\")
	for _, f := range zr.File {
		if f.Name == pathSlash || f.Name == backslash {
			return f
		}
	}
	return nil
}

func readZipEntry(f *zip.File) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

// ─── extractDocxBodyText ──────────────────────────────────────────────────────

// extractDocxBodyText extracts the body text of a .docx using the same
// flattening rules as the tracked-changes matcher (accepted view). Paragraphs
// are joined by a single newline — the output exactly mirrors the string the
// anchor matcher operates against.
func extractDocxBodyText(docxBytes []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(docxBytes), int64(len(docxBytes)))
	if err != nil {
		return "", err
	}
	entry := findZipEntry(zr, "word/document.xml")
	if entry == nil {
		return "", nil
	}
	raw, err := readZipEntry(entry)
	if err != nil {
		return "", err
	}
	tree, err := parseXMLFragment(string(raw))
	if err != nil {
		return "", err
	}
	body := findBody(tree)
	if body == nil {
		return "", nil
	}
	var refs []paragraphRef
	collectParagraphs(body.Children, &refs)
	lines := make([]string, len(refs))
	for i, p := range refs {
		lines[i] = string(p.flat.paraText)
	}
	return strings.Join(lines, "\n"), nil
}

// ─── applyTrackedEdits ────────────────────────────────────────────────────────

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// applyTrackedEdits rewrites the .docx so the requested substitutions appear
// as tracked changes. It returns the new bytes plus per-edit annotations and
// per-edit errors (failed edits never abort the whole batch).
func applyTrackedEdits(docxBytes []byte, edits []EditInput, author string) ([]byte, []AppliedChange, []EditError, error) {
	if author == "" {
		author = "Big Michael"
	}
	now := time.Now().UTC().Format("2006-01-02T15:04:05Z")

	zr, err := zip.NewReader(bytes.NewReader(docxBytes), int64(len(docxBytes)))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("not a valid .docx archive: %w", err)
	}
	docEntry := findZipEntry(zr, "word/document.xml")
	if docEntry == nil {
		return nil, nil, nil, fmt.Errorf("document.xml missing from docx")
	}
	docXMLRaw, err := readZipEntry(docEntry)
	if err != nil {
		return nil, nil, nil, err
	}
	tree, err := parseXMLFragment(string(docXMLRaw))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("failed to parse document.xml: %w", err)
	}
	body := findBody(tree)
	if body == nil {
		return nil, nil, nil, fmt.Errorf("w:body missing from document.xml")
	}

	var paragraphs []paragraphRef
	collectParagraphs(body.Children, &paragraphs)

	// Precompute normalized forms per paragraph for reuse across edits.
	paraNorms := make([]tcNormalized, len(paragraphs))
	for i, p := range paragraphs {
		paraNorms[i] = normalizeWs(p.flat.paraText)
	}

	nextWID := maxTrackedID(tree) + 1
	plansPerParagraph := map[int][]*plannedChange{}
	var appliedChanges []AppliedChange
	var editErrors []EditError

	for editIdx, edit := range edits {
		find := edit.Find
		replace := edit.Replace

		if find == "" && replace == "" {
			editErrors = append(editErrors, EditError{Index: editIdx, Reason: "Empty edit."})
			continue
		}
		if find == "" && edit.ContextBefore == "" && edit.ContextAfter == "" {
			editErrors = append(editErrors, EditError{
				Index: editIdx, Reason: "Pure insertion requires context_before or context_after.",
			})
			continue
		}

		findNorm := normalizeWs([]rune(find)).norm
		ctxBeforeNorm := normalizeWs([]rune(edit.ContextBefore)).norm
		ctxAfterNorm := normalizeWs([]rune(edit.ContextAfter)).norm

		// Strategy:
		//   1) find + full context  (strictest — preferred)
		//   2) find + half context  (drop one context side)
		//   3) find alone           (only if globally unique across doc)
		// At each stage every paragraph is scanned. "Unique across the doc"
		// means exactly one paragraph yields exactly one match.
		type hit struct{ paraIdx, normStart, normEnd int }

		tryStrategy := func(cb, ca []rune) ([]hit, bool /*ambiguous*/) {
			var hits []hit
			ambiguous := false
			for pi := range paragraphs {
				s, e, kind := findUniqueAnchor(paraNorms[pi].norm, findNorm, cb, ca)
				if kind != "" {
					if kind == "ambiguous" {
						ambiguous = true
					}
					continue
				}
				hits = append(hits, hit{paraIdx: pi, normStart: s, normEnd: e})
			}
			if ambiguous || len(hits) > 1 {
				return nil, true
			}
			return hits, false
		}

		attempts := [][2][]rune{
			{ctxBeforeNorm, ctxAfterNorm},
			{ctxBeforeNorm, nil},
			{nil, ctxAfterNorm},
			{nil, nil}, // find-only
		}
		var selected *hit
		sawAmbiguous := false
		for _, att := range attempts {
			hits, ambiguous := tryStrategy(att[0], att[1])
			if ambiguous {
				sawAmbiguous = true
				continue
			}
			if len(hits) == 1 {
				h := hits[0]
				selected = &h
				break
			}
		}

		if selected == nil {
			reason := fmt.Sprintf(
				"Could not locate find=%q in the document. Re-read the document and copy context verbatim (including punctuation & whitespace).",
				truncateRunes(find, 80))
			if sawAmbiguous {
				reason = fmt.Sprintf(
					"Ambiguous match for find=%q. Add longer context_before / context_after so the anchor is unique.",
					truncateRunes(find, 80))
			}
			editErrors = append(editErrors, EditError{Index: editIdx, Reason: reason})
			continue
		}

		paraIdx := selected.paraIdx
		origLen := len(paragraphs[paraIdx].flat.paraText)
		findStart, findEnd := mapNormRangeToOriginal(paraNorms[paraIdx], origLen, selected.normStart, selected.normEnd)

		// Use the actual original text in that range as deletedText — this
		// preserves the document's whitespace/quote style rather than the
		// normalized needle the LLM provided.
		originalFind := paragraphs[paraIdx].flat.paraText[findStart:findEnd]

		deleted, inserted, leadingEq := collapseDiff(originalFind, []rune(replace))
		minStart := findStart + leadingEq
		minEnd := minStart + len(deleted)

		plan := &plannedChange{
			editIndex:     editIdx,
			deleteStart:   minStart,
			deleteEnd:     minEnd,
			deletedText:   string(deleted),
			insertedText:  string(inserted),
			contextBefore: edit.ContextBefore,
			contextAfter:  edit.ContextAfter,
			reason:        edit.Reason,
			changeID:      fmt.Sprintf("bigmichael-%d-%d", editIdx, time.Now().UnixMilli()),
		}
		if len(deleted) > 0 {
			plan.delWID = strconv.Itoa(nextWID)
			nextWID++
		}
		if len(inserted) > 0 {
			plan.insWID = strconv.Itoa(nextWID)
			nextWID++
		}

		// Check for overlap with earlier plans in the same paragraph.
		existing := plansPerParagraph[paraIdx]
		overlap := false
		for _, p := range existing {
			if !(plan.deleteEnd <= p.deleteStart || plan.deleteStart >= p.deleteEnd) {
				overlap = true
				break
			}
		}
		if overlap {
			editErrors = append(editErrors, EditError{
				Index: editIdx, Reason: "Overlaps a previous edit in the same paragraph.",
			})
			continue
		}

		existing = append(existing, plan)
		for i := 1; i < len(existing); i++ { // insertion sort by deleteStart
			for j := i; j > 0 && existing[j].deleteStart < existing[j-1].deleteStart; j-- {
				existing[j], existing[j-1] = existing[j-1], existing[j]
			}
		}
		plansPerParagraph[paraIdx] = existing

		appliedChanges = append(appliedChanges, AppliedChange{
			ID:            plan.changeID,
			DelID:         plan.delWID,
			InsID:         plan.insWID,
			DeletedText:   plan.deletedText,
			InsertedText:  plan.insertedText,
			ContextBefore: plan.contextBefore,
			ContextAfter:  plan.contextAfter,
			Reason:        plan.reason,
		})
	}

	// Apply plans per paragraph.
	for paraIdx, plan := range plansPerParagraph {
		p := paragraphs[paraIdx]
		p.paraNode.Children = reconstructParagraph(p.paraNode.Children, p.flat, plan, now, author)
	}

	// Rebuild document.xml and rezip, copying all other entries verbatim.
	rebuilt := serializeXML(tree)
	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	for _, f := range zr.File {
		if f.Name == docEntry.Name {
			w, err := zw.Create(f.Name)
			if err != nil {
				return nil, nil, nil, err
			}
			if _, err := w.Write([]byte(rebuilt)); err != nil {
				return nil, nil, nil, err
			}
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, nil, nil, err
		}
		w, err := zw.Create(f.Name)
		if err != nil {
			rc.Close()
			return nil, nil, nil, err
		}
		if _, err := io.Copy(w, rc); err != nil {
			rc.Close()
			return nil, nil, nil, err
		}
		rc.Close()
	}
	if err := zw.Close(); err != nil {
		return nil, nil, nil, err
	}
	return out.Bytes(), appliedChanges, editErrors, nil
}

// ─── register ─────────────────────────────────────────────────────────────────

func (r *Registry) registerTrackedChangesTools() {
	r.Register(r.editDocumentTool())
}

// ─── edit_document ────────────────────────────────────────────────────────────

func (r *Registry) editDocumentTool() *ToolImpl {
	return &ToolImpl{
		Name: "edit_document",
		Schema: providers.ToolParam{
			Name: "edit_document",
			Description: "Propose edits to a .docx file as Word tracked changes. Each edit is a precise, minimal " +
				"substitution of specific words/characters (NOT a whole-paragraph replacement). Anchor each edit " +
				"with short before/after context so it can be located unambiguously. Operates on a .docx file by " +
				"path (e.g. one produced by docx_generate, relative to the output dir, or an absolute path). " +
				"Writes a new redlined .docx and returns per-edit annotations plus the output path.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path":   map[string]interface{}{"type": "string", "description": "Path to the .docx to edit (absolute, or relative to the document output dir)."},
					"author": map[string]interface{}{"type": "string", "description": "Tracked-change author name (default 'Big Michael')."},
					"edits": map[string]interface{}{
						"type":        "array",
						"description": "List of precise substitutions.",
						"items": map[string]interface{}{
							"type": "object",
							"properties": map[string]interface{}{
								"find":           map[string]interface{}{"type": "string", "description": "Exact substring to replace (keep it as short as possible)."},
								"replace":        map[string]interface{}{"type": "string", "description": "Replacement text. Empty string = pure deletion."},
								"context_before": map[string]interface{}{"type": "string", "description": "~40 chars immediately preceding `find`."},
								"context_after":  map[string]interface{}{"type": "string", "description": "~40 chars immediately following `find`."},
								"reason":         map[string]interface{}{"type": "string", "description": "Short explanation shown on the change card."},
							},
							"required": []string{"find", "replace", "context_before", "context_after"},
						},
					},
				},
				"required": []string{"path", "edits"},
			},
		},
		Exec: func(input map[string]interface{}, _ agents.ToolContext) (interface{}, error) {
			rawPath := strInput(input, "path")
			author := strInput(input, "author")

			var edits []EditInput
			if rawEdits, ok := input["edits"].([]interface{}); ok {
				for _, re := range rawEdits {
					m, _ := re.(map[string]interface{})
					if m == nil {
						continue
					}
					edits = append(edits, EditInput{
						Find:          strInput(m, "find"),
						Replace:       strInput(m, "replace"),
						ContextBefore: strInput(m, "context_before"),
						ContextAfter:  strInput(m, "context_after"),
						Reason:        strInput(m, "reason"),
					})
				}
			}

			resolved, err := r.resolveDocxOutputPath(rawPath)
			if err != nil {
				return map[string]interface{}{"ok": false, "error": fmt.Sprintf("File not found: '%s'.", rawPath)}, nil
			}
			if strings.ToLower(filepath.Ext(resolved)) != ".docx" {
				return map[string]interface{}{"ok": false, "error": "edit_document only supports .docx files."}, nil
			}
			if len(edits) == 0 {
				return map[string]interface{}{"ok": false, "error": "No edits supplied."}, nil
			}

			data, err := os.ReadFile(resolved)
			if err != nil {
				return map[string]interface{}{"ok": false, "error": fmt.Sprintf("Could not read file: %s", err)}, nil
			}

			outBytes, changes, editErrs, err := applyTrackedEdits(data, edits, author)
			if err != nil {
				return map[string]interface{}{"ok": false, "error": err.Error()}, nil
			}
			dir := filepath.Dir(resolved)
			stem := strings.TrimSuffix(filepath.Base(resolved), ".docx")
			outPath := filepath.Join(dir, stem+".redlined.docx")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return nil, err
			}
			if err := os.WriteFile(outPath, outBytes, 0o644); err != nil {
				return nil, err
			}
			if changes == nil {
				changes = []AppliedChange{}
			}
			if editErrs == nil {
				editErrs = []EditError{}
			}
			return map[string]interface{}{
				"ok":           true,
				"outputPath":   outPath,
				"appliedCount": len(changes),
				"errorCount":   len(editErrs),
				"annotations":  changes,
				"errors":       editErrs,
			}, nil
		},
	}
}
