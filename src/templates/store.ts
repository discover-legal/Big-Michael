// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Discover Legal
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

import { readdir, readFile } from "fs/promises";
import { join, extname, dirname } from "path";
import { fileURLToPath } from "url";
import { logger } from "../logger.js";
import type { TaskTemplate } from "../adapters/lavern.js";

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
