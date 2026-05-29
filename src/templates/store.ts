// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Discover Legal
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, version 3.
// See <https://www.gnu.org/licenses/gpl-3.0.html>

import { readdir, readFile } from "fs/promises";
import { join, extname, dirname } from "path";
import { fileURLToPath } from "url";
import { logger } from "../logger.js";
import type { TaskTemplate } from "../adapters/laverne.js";

const DEFAULT_TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)));

export class TemplateStore {
  private readonly templates: Map<string, TaskTemplate> = new Map();

  async load(dir: string = DEFAULT_TEMPLATE_DIR): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      logger.warn("Template directory not readable — skipping", { dir });
      return;
    }

    let loaded = 0;
    for (const entry of entries) {
      if (extname(entry) !== ".json") continue;
      try {
        const raw = await readFile(join(dir, entry), "utf8");
        const parsed = JSON.parse(raw) as TaskTemplate | TaskTemplate[];
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const t of items) {
          this.templates.set(t.id, t);
          loaded++;
        }
      } catch (err) {
        logger.warn("Failed to parse template file", { file: entry, error: (err as Error).message });
      }
    }

    logger.info("Templates loaded", { count: loaded, dir });
  }

  get(id: string): TaskTemplate | null {
    return this.templates.get(id) ?? null;
  }

  list(): TaskTemplate[] {
    return Array.from(this.templates.values());
  }

  add(template: TaskTemplate): void {
    this.templates.set(template.id, template);
  }
}
