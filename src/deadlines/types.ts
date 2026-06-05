// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

export type DayType = "calendar" | "business";

export interface DeadlineRule {
  id: string;
  trigger: string;          // e.g. "complaint_served", "motion_filed"
  event: string;            // e.g. "answer_due", "opposition_due"
  days: number;             // positive integer
  dayType: DayType;         // calendar = includes weekends/holidays; business = excludes them
  cite: string;             // rule citation, e.g. "FRCP 12(a)(1)(A)(i)"
  note?: string;            // optional human note
  warningDays?: number;     // emit a warning this many days before deadline
}

export interface JurisdictionRules {
  id: string;               // e.g. "us-federal-frcp"
  jurisdiction: string;     // e.g. "US-FED", "UK", "EU-COMP"
  name: string;             // e.g. "Federal Rules of Civil Procedure"
  version: string;          // e.g. "2024"
  source?: string;          // URL to the authoritative source
  holidays: "us_federal" | "uk_bank" | "eu_institutions" | "none";
  rules: DeadlineRule[];
}

export interface ComputedDeadline {
  ruleId: string;
  event: string;
  dueDate: string;          // ISO date string "YYYY-MM-DD"
  warningDate?: string;     // ISO — warningDays before dueDate
  days: number;
  dayType: DayType;
  cite: string;
  note?: string;
}

export interface DeadlineResult {
  jurisdiction: string;
  jurisdictionName: string;
  triggerEvent: string;
  triggerDate: string;      // ISO
  computedAt: string;       // ISO
  deadlines: ComputedDeadline[];
}
