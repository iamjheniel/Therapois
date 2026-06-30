// Staging backend health gate.
//
// Probes the authenticated staging API. If the backend is down (HTTP 5xx or a
// network error on every attempt) the staging E2E suite would otherwise produce
// a wall of misleading "element not found" / "1-0 of 0" failures. Instead, this
// script reports `up=false` so CI can SKIP the staging test steps and stay green.
//
// Contract:
//   - Always exits 0 (the gating happens via the `up` output, not the exit code).
//   - Writes `up=true|false` to $GITHUB_OUTPUT (when running under Actions).
//   - Prints a clear one-line verdict either way.
//
// "Up" means the server responded with any non-5xx status (200, 401, 403, ...) —
// an expired token (401) still means the backend itself is alive. "Down" means
// every attempt returned 5xx or failed to connect.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_BASE = process.env.STAGING_API_BASE || 'https://api.staging.therapios.de';
const HEALTH_PATH = '/me';
const AUTH_FILE = path.join(__dirname, '..', '.auth', 'SuperAdmin.json');
const ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 15_000;
const GAP_MS = 3_000;

function readToken() {
  try {
    const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    for (const origin of state.origins ?? []) {
      for (const ls of origin.localStorage ?? []) {
        if (ls.name === 'auth-state') {
          return JSON.parse(ls.value)?.token ?? null;
        }
      }
    }
  } catch {
    // fall through — no token available
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeOnce(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${HEALTH_PATH}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    return { ok: res.status < 500, status: String(res.status) };
  } catch (err) {
    return { ok: false, status: err?.name === 'AbortError' ? 'timeout' : 'network-error' };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const token = readToken();
  if (!token) {
    // Can't probe authenticated endpoints — assume up so we don't silently skip
    // the whole suite over a missing auth file. The suite's own auth will surface it.
    console.log('⚠️  No staging auth token found; assuming backend UP (suite will run).');
    return setOutput(true);
  }

  const statuses = [];
  let up = false;
  for (let i = 1; i <= ATTEMPTS; i++) {
    const { ok, status } = await probeOnce(token);
    statuses.push(status);
    if (ok) {
      up = true;
      break;
    }
    if (i < ATTEMPTS) await sleep(GAP_MS);
  }

  if (up) {
    console.log(`✅ Staging backend is UP (GET ${HEALTH_PATH} → ${statuses.join(', ')}).`);
  } else {
    console.log(
      `🔴 Staging backend is DOWN — GET ${HEALTH_PATH} returned [${statuses.join(', ')}] ` +
        `on ${ATTEMPTS} attempts. Skipping staging tests so CI stays green.`,
    );
  }
  setOutput(up);
}

function setOutput(up) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `up=${up ? 'true' : 'false'}\n`);
  }
}

main().catch((err) => {
  // Never fail the run on an unexpected error in the probe itself — assume up.
  console.log(`⚠️  Health probe errored unexpectedly (${err?.message}); assuming backend UP.`);
  setOutput(true);
});
