// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Discover Legal
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Infisical secrets loader — must run BEFORE config.ts is imported.
 *
 * Infisical (https://infisical.com) is a fully open-source, self-hostable
 * secrets manager. Self-host with Docker:
 *   docker run -d -p 8080:8080 infisical/infisical:latest
 *
 * This module calls the Infisical REST API directly (no SDK) so there are
 * no runtime version-mismatch issues.
 *
 * Flow:
 *   1. On startup call loadSecrets() before any other import.
 *   2. If INFISICAL_CLIENT_ID / CLIENT_SECRET / PROJECT_ID are present,
 *      authenticate with Universal Auth and list all secrets in the path.
 *   3. Any secret not already in process.env is injected, so config.ts
 *      picks it up as if it were set in a .env file.
 *   4. If Infisical is not configured, the loader exits immediately —
 *      dotenv values continue to work unchanged.
 *
 * Only INFISICAL_* vars need to be in the local .env file.
 * Everything else — API keys, tokens, passwords — lives in Infisical.
 */

interface InfisicalSecret {
  secretKey: string;
  secretValue: string;
}

interface LoginResponse {
  accessToken: string;
  tokenType: string;
}

interface SecretsResponse {
  secrets: InfisicalSecret[];
}

export interface SecretsLoadResult {
  source: "infisical" | "env";
  count: number;
  infisicalUrl?: string;
}

/**
 * Load secrets from Infisical and inject into process.env.
 * Safe to call multiple times — already-set vars are never overwritten.
 * Never throws — on failure logs a warning and falls back to existing env.
 */
export async function loadSecrets(): Promise<SecretsLoadResult> {
  const clientId     = process.env.INFISICAL_CLIENT_ID;
  const clientSecret = process.env.INFISICAL_CLIENT_SECRET;
  const projectId    = process.env.INFISICAL_PROJECT_ID;

  if (!clientId || !clientSecret || !projectId) {
    return { source: "env", count: 0 };
  }

  const infisicalUrl = process.env.INFISICAL_URL ?? "https://app.infisical.com";
  const environment  = process.env.INFISICAL_ENV ?? "production";
  const secretPath   = process.env.INFISICAL_PATH ?? "/";

  try {
    // ── Step 1: Universal Auth login → access token ───────────────────────
    const loginRes = await fetch(`${infisicalUrl}/api/v1/auth/universal-auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret }),
    });

    if (!loginRes.ok) {
      const body = await loginRes.text();
      throw new Error(`Infisical auth failed (${loginRes.status}): ${body.slice(0, 200)}`);
    }

    const { accessToken } = (await loginRes.json()) as LoginResponse;

    // ── Step 2: Fetch secrets for the project + environment ───────────────
    const url = new URL(`${infisicalUrl}/api/v3/secrets/raw`);
    url.searchParams.set("workspaceId", projectId);
    url.searchParams.set("environment", environment);
    url.searchParams.set("secretPath", secretPath);
    url.searchParams.set("recursive", "true");

    const secretsRes = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!secretsRes.ok) {
      const body = await secretsRes.text();
      throw new Error(`Infisical secrets fetch failed (${secretsRes.status}): ${body.slice(0, 200)}`);
    }

    const { secrets } = (await secretsRes.json()) as SecretsResponse;

    // ── Step 3: Inject into process.env (never overwrite existing values) ─
    let count = 0;
    for (const { secretKey, secretValue } of secrets) {
      if (process.env[secretKey] === undefined) {
        process.env[secretKey] = secretValue;
        count++;
      }
    }

    console.log(
      `[secrets] Loaded ${count} secret(s) from Infisical` +
      ` (${infisicalUrl}, env=${environment}, skipped ${secrets.length - count} already-set)`,
    );

    return { source: "infisical", count, infisicalUrl };
  } catch (err) {
    console.warn(
      `[secrets] WARNING: Could not load from Infisical — falling back to env vars.\n  ${(err as Error).message}`,
    );
    return { source: "env", count: 0 };
  }
}
