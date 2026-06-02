// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See <https://www.gnu.org/licenses/>.

/**
 * Word (.docx) generation tool.
 *
 * Ported from Mike (https://github.com/willchen96/mike, AGPL-3.0) — its
 * generate_docx capability — and adapted to Big Michael's tool registry.
 * Uses the `docx` library to build a Word document from structured sections
 * (heading / prose / table), with optional landscape orientation and page
 * breaks (e.g. for contract signature pages).
 */

import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, PageOrientation, AlignmentType,
} from "docx";
import { writeFile, mkdir } from "fs/promises";
import { join, resolve, sep } from "path";
import { Config } from "../config.js";
import type { ToolImpl } from "./index.js";

const FONT = "Times New Roman";
const BODY_SIZE = 22; // half-points → 11pt

interface DocxSection {
  heading?: string;
  level?: number;
  content?: string;
  pageBreak?: boolean;
  table?: { headers: string[]; rows: string[][] };
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];

function proseParagraphs(content: string): Paragraph[] {
  return content
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => new Paragraph({
      spacing: { after: 160 },
      alignment: AlignmentType.JUSTIFIED,
      children: [new TextRun({ text: p.replace(/\n/g, " "), font: FONT, size: BODY_SIZE })],
    }));
}

function buildTable(headers: string[], rows: string[][]): Table {
  const cell = (text: string, bold: boolean) =>
    new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text: String(text ?? ""), bold, font: FONT, size: 20 })] })],
    });
  const headerRow = new TableRow({ tableHeader: true, children: headers.map((h) => cell(h, true)) });
  const bodyRows = rows.map((r) => new TableRow({ children: headers.map((_, i) => cell(r[i] ?? "", false)) }));
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...bodyRows] });
}

export const docxGenerateTool: ToolImpl = {
  name: "docx_generate",
  schema: {
    name: "docx_generate",
    description:
      "Generate a Word (.docx) legal document from structured content (headings, prose, tables). " +
      "Use when drafting or producing a deliverable document. Supports landscape orientation and page breaks. " +
      "Returns the output file path.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Document title (used as filename and H1 heading)" },
        filename: { type: "string", description: "Optional output filename (defaults to a slug of the title)" },
        landscape: { type: "boolean", description: "True for landscape orientation (e.g. wide checklists/tables)" },
        sections: {
          type: "array",
          description: "Document sections, each with an optional heading, prose content, and/or table.",
          items: {
            type: "object",
            properties: {
              heading: { type: "string" },
              level: { type: "integer", description: "Heading level 1-3" },
              content: { type: "string", description: "Prose (paragraphs separated by blank lines)" },
              pageBreak: { type: "boolean", description: "Start this section on a new page" },
              table: {
                type: "object",
                properties: {
                  headers: { type: "array", items: { type: "string" } },
                  rows: { type: "array", items: { type: "array", items: { type: "string" } } },
                },
                required: ["headers", "rows"],
              },
            },
          },
        },
      },
      required: ["title", "sections"],
    },
  },
  async execute(input, _ctx) {
    const title = String(input.title ?? "Legal Document");
    const landscape = input.landscape === true;
    const sections = (input.sections as DocxSection[] | undefined) ?? [];
    // Always write into the configured output directory — ignore any caller-supplied
    // output_dir to prevent path-traversal to arbitrary filesystem locations.
    const outputRoot = resolve(Config.pdf.outputDir);
    const slug = (String(input.filename ?? title)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
    const filename = slug.endsWith(".docx") ? slug : `${slug || "document"}.docx`;
    const outputDir = outputRoot;
    // Belt-and-suspenders: verify the resolved output path stays within outputRoot.
    const outputPath = join(outputDir, filename);
    if (!resolve(outputPath).startsWith(outputRoot + sep) && resolve(outputPath) !== outputRoot) {
      throw new Error("Resolved output path escapes the configured output directory");
    }

    const children: (Paragraph | Table)[] = [
      new Paragraph({ heading: HeadingLevel.TITLE, spacing: { after: 240 }, children: [new TextRun({ text: title, font: FONT, bold: true, size: 32 })] }),
    ];

    for (const s of sections) {
      if (s.pageBreak) children.push(new Paragraph({ children: [], pageBreakBefore: true }));
      if (s.heading) {
        const lvl = HEADINGS[Math.min(Math.max((s.level ?? 1) - 1, 0), 2)];
        children.push(new Paragraph({ heading: lvl, spacing: { before: 240, after: 120 }, children: [new TextRun({ text: s.heading, font: FONT, bold: true, size: 26 })] }));
      }
      if (s.content) children.push(...proseParagraphs(s.content));
      if (s.table?.headers?.length) {
        children.push(buildTable(s.table.headers, s.table.rows ?? []));
        children.push(new Paragraph({ children: [], spacing: { after: 160 } }));
      }
    }

    const doc = new Document({
      sections: [{
        properties: landscape ? { page: { size: { orientation: PageOrientation.LANDSCAPE } } } : {},
        children,
      }],
    });

    const buf = await Packer.toBuffer(doc);
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPath, buf);

    return { outputPath, filename, sectionCount: sections.length, landscape, fileSizeBytes: buf.length };
  },
};
