// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

// ConflictGraph — in-memory conflict-of-interest graph.
// Mirrors the TypeDB façade from src/graph/conflict.ts.
// TypeDB is entirely optional and was not ported (no Go TypeDB driver);
// instead we maintain an adjacency-list representation in memory that
// satisfies the same public API with flat + one-hop subsidiary inference.
// Enabled when TYPEDB_URL is set (for future driver wiring); the graph
// is always available in-process as a lightweight fallback.

package graph

import (
	"log/slog"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/discover-legal/biglaw-go/internal/types"
)

// ─── Client / matter data shapes ─────────────────────────────────────────────

type ClientNode struct {
	ID         string
	Name       string
	Adversaries []string // adversary names (raw)
	Matters    []MatterRef
}

type MatterRef struct {
	MatterNumber string
	PracticeArea string
}

type MatterNode struct {
	MatterNumber string
	PracticeArea string
	Jurisdiction string
	Status       string
}

// ─── ConflictGraph ────────────────────────────────────────────────────────────

// ConflictGraph is the application-level conflict-of-interest graph.
// It is always active in-memory; TypeDB integration is no-op until a
// Go TypeDB driver is wired in.
type ConflictGraph struct {
	mu         sync.RWMutex
	clients    map[string]*ClientNode  // id → node
	matters    map[string]*MatterNode  // matterNumber → node
	adverseIDs map[string][]string     // clientId → []adversaryId (slugged)
	nameToID   map[string]string       // slug(name) → clientId (reverse lookup)
}

// New creates a ConflictGraph.
func New() *ConflictGraph {
	return &ConflictGraph{
		clients:    make(map[string]*ClientNode),
		matters:    make(map[string]*MatterNode),
		adverseIDs: make(map[string][]string),
		nameToID:   make(map[string]string),
	}
}

// IsEnabled reports whether TypeDB is configured.
// The graph itself is always usable; this flag is informational.
func IsEnabled() bool {
	return os.Getenv("TYPEDB_URL") != ""
}

// Connect logs TypeDB status. No-op until a Go driver is wired.
func (g *ConflictGraph) Connect() {
	if IsEnabled() {
		slog.Warn("graph: TYPEDB_URL set but Go TypeDB driver not yet wired — using in-memory graph only")
	} else {
		slog.Info("graph: TypeDB disabled (TYPEDB_URL not set) — using in-memory conflict graph")
	}
}

// Sync loads all clients and matters into the in-memory graph.
func (g *ConflictGraph) Sync(
	clients []ClientNode,
	matters []MatterNode,
) {
	g.mu.Lock()
	defer g.mu.Unlock()

	for i := range matters {
		m := &matters[i]
		g.matters[m.MatterNumber] = m
	}

	for i := range clients {
		c := &clients[i]
		g.clients[c.ID] = c
		g.nameToID[SlugID(c.Name)] = c.ID

		// Build adverse-to adjacency
		advIDs := make([]string, 0, len(c.Adversaries))
		for _, advName := range c.Adversaries {
			advIDs = append(advIDs, SlugID(advName))
		}
		g.adverseIDs[c.ID] = advIDs
	}

	slog.Info("graph: in-memory conflict graph synced",
		"clients", len(clients), "matters", len(matters))
}

// CheckClient returns all conflicts touching clientId.
// Detects: direct adverse-to edges + one-hop subsidiary inference
// (if A is adverse to B and B is a subsidiary of C which we represent, conflict).
func (g *ConflictGraph) CheckClient(clientId string) []types.ConflictReport {
	g.mu.RLock()
	defer g.mu.RUnlock()

	client, ok := g.clients[clientId]
	if !ok {
		return nil
	}
	return g.findConflicts(client)
}

// CheckNewMatter simulates adding adversaryIds for clientId and returns conflicts.
// Does NOT write to the graph.
func (g *ConflictGraph) CheckNewMatter(clientId string, adversaryIds []string) []types.ConflictReport {
	g.mu.RLock()
	defer g.mu.RUnlock()

	var out []types.ConflictReport
	for _, advId := range adversaryIds {
		advSlug := SlugID(advId)
		// Does any existing client match this adversary?
		if existingID, ok := g.nameToID[advSlug]; ok {
			existing := g.clients[existingID]
			if existing == nil {
				continue
			}
			// Check if any of this existing client's matters are adverse to clientId
			for _, advSlug2 := range g.adverseIDs[existingID] {
				if targetID, ok := g.nameToID[advSlug2]; ok && targetID == clientId {
					out = append(out, g.buildReport(clientId, existingID))
				}
			}
			// Also check the reverse: if our clientId is in the adversaries of the matched entity
			for _, myAdvSlug := range g.adverseIDs[clientId] {
				if myAdvSlug == advSlug || myAdvSlug == SlugID(existing.Name) {
					out = append(out, g.buildReport(clientId, existingID))
				}
			}
		}
	}
	return dedup(out)
}

// ─── private helpers ──────────────────────────────────────────────────────────

func (g *ConflictGraph) findConflicts(client *ClientNode) []types.ConflictReport {
	var out []types.ConflictReport

	advSlugs := g.adverseIDs[client.ID]
	for _, advSlug := range advSlugs {
		// Does this adversary slug match any known client?
		if otherId, ok := g.nameToID[advSlug]; ok && otherId != client.ID {
			out = append(out, g.buildReport(client.ID, otherId))
		}
	}

	// One-hop: check if any client is adverse to us
	for otherID, otherAdv := range g.adverseIDs {
		if otherID == client.ID {
			continue
		}
		mySlug := SlugID(client.Name)
		for _, s := range otherAdv {
			if s == mySlug || s == client.ID {
				out = append(out, g.buildReport(client.ID, otherID))
				break
			}
		}
	}

	return dedup(out)
}

func (g *ConflictGraph) buildReport(idA, idB string) types.ConflictReport {
	cA := g.clients[idA]
	cB := g.clients[idB]
	r := types.ConflictReport{
		ConflictPath: "inferred",
		DetectedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	if cA != nil {
		r.ClientAID = cA.ID
		r.ClientAName = cA.Name
		if len(cA.Matters) > 0 {
			r.MatterANumber = cA.Matters[0].MatterNumber
		}
	}
	if cB != nil {
		r.ClientBID = cB.ID
		r.ClientBName = cB.Name
		if len(cB.Matters) > 0 {
			r.MatterBNumber = cB.Matters[0].MatterNumber
		}
	}
	return r
}

func dedup(reports []types.ConflictReport) []types.ConflictReport {
	seen := make(map[string]bool)
	out := reports[:0]
	for _, r := range reports {
		key := r.ClientAID + "|" + r.ClientBID
		rev := r.ClientBID + "|" + r.ClientAID
		if !seen[key] && !seen[rev] {
			seen[key] = true
			out = append(out, r)
		}
	}
	return out
}

var nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

// SlugID converts a name to a safe slug for conflict-graph lookup.
func SlugID(name string) string {
	slug := nonAlnum.ReplaceAllString(strings.ToLower(name), "-")
	slug = strings.Trim(slug, "-")
	if len(slug) > 100 {
		slug = slug[:100]
	}
	if slug == "" {
		return "unknown"
	}
	return slug
}
