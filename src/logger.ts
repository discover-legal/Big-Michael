// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Discover Legal
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

import { createLogger, format, transports } from "winston";
import { Config } from "./config.js";

export const logger = createLogger({
  level: Config.logging.level,
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.colorize(),
    format.printf(({ timestamp, level, message, ...meta }) => {
      const extras = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
      return `${timestamp} [${level}] ${message}${extras}`;
    }),
  ),
  transports: [new transports.Console()],
});