# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Layne is a centralized appsec scanning GitHub App. It receives `pull_request` webhooks from GitHub, enqueues scan jobs via BullMQ/Redis, and posts results back as GitHub Check Run annotations. It runs three scanners: Semgrep (SAST), Trufflehog (secret detection), and Claude (malicious intent detection).

## Commands

```bash
# Run the webhook server
npm start           # node src/server.js

# Run the job worker
npm run worker      # node src/worker.js

# Tests
npm test            # vitest run (single pass)
npm run test:watch  # vitest (watch mode)
npm run test:coverage

# Run a single test file
npx vitest run src/__tests__/github.test.js
```

## Required environment variables

```
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY   # single-line PEM with literal \n between lines
GITHUB_WEBHOOK_SECRET
REDIS_URL                # defaults to redis://localhost:6379
PORT                     # defaults to 3000
ANTHROPIC_API_KEY        # optional at startup; required when any repo has claude.enabled: true
```

`validateEnv()` in `src/env.js` checks the first three at startup and exits if any are missing.

## Architecture

The system has two separate Node.js processes:

**`src/server.js` — Webhook receiver**
- Express app with a single `POST /webhook` route
- Verifies GitHub HMAC signature before processing
- On a qualifying `pull_request` event (opened/synchronize/reopened), immediately creates a GitHub Check Run in `queued` state, then enqueues a BullMQ job and returns 200
- Job ID is deduplicated by `{repo}#{pr}@{sha}` so duplicate webhook deliveries are no-ops
- Exported `app` (without `listen`) for use in tests

**`src/worker.js` — Job processor**
- BullMQ `Worker` consuming the `scans` queue with concurrency 3
- `processJob()` is exported for direct testing without Redis
- Per-job 10-minute timeout via `Promise.race`
- Graceful shutdown on SIGTERM/SIGINT — finishes in-flight jobs before exiting

**Job lifecycle (inside `runScan`):**
1. Mark Check Run `in_progress`
2. Authenticate as installation via `src/auth.js` → short-lived token
3. Create temp workspace (`src/fetcher.js` → `createWorkspace`)
4. Shallow-clone the exact head SHA (not branch name, to avoid race conditions)
5. Fetch base ref as `FETCH_HEAD` for diff operations
6. Get changed files via `git diff --name-only -z FETCH_HEAD`
7. Run scanners in parallel via `src/dispatcher.js` → `dispatch()`
8. Convert findings to annotations via `src/reporter.js` → `buildAnnotations()`
9. Complete Check Run; clean up workspace in `finally`

**Scanners (`src/adapters/`):**
- `semgrep.js` — runs `semgrep scan --config auto --json`; exit code 1 = findings found (not an error); maps ERROR→high, WARNING→medium, INFO→low
- `trufflehog.js` — runs `trufflehog filesystem --json --no-update` on changed files; exit code 183 = secrets found (not an error); batched at 200 files to stay under ARG_MAX; all findings are severity `high`
- `claude.js` — calls the Anthropic API with tool use to detect malicious intent (reverse shells, backdoors, exfiltration, obfuscated payloads); **disabled by default**, must be opted in per repo in `config/repos.json`; skips binary files; caps files at 50 KB; batches at 100 KB of text per API call; API errors are caught and logged — the scan continues without Claude findings rather than failing

**Common finding shape:**
```js
{ file, line, severity, message, ruleId, tool }
```

**Severity → GitHub annotation level:**
- `critical` / `high` → `failure` (blocks merge)
- `medium` → `warning`
- `low` / `info` → `notice`

**GitHub Check Run annotations** are chunked at 50 per API call (GitHub API limit), with `status: completed` set only on the last chunk.

## Per-repo configuration

Scanner behaviour is configured in `config/repos.json`, keyed by `"owner/repo"`. The file is read once at worker startup and cached. **Restart the worker to pick up changes** (the deploy pipeline does this automatically).

```json
{
  "owner/repo": {
    "semgrep":    { "enabled": true, "extraArgs": ["--config", "p/owasp-top-ten"] },
    "trufflehog": { "enabled": true, "extraArgs": ["--only-verified"] },
    "claude":     { "enabled": true, "model": "claude-haiku-4-5-20251001" }
  }
}
```

Defaults: Semgrep and Trufflehog are enabled with no extra args; Claude is disabled. `extraArgs` fully replaces the default (not extended). The `claude` block uses `model` instead of `extraArgs`.

**Important:** `config/repos.json` must be present in the Docker image — the Dockerfile explicitly copies it with `COPY config/ ./config/`. If it's missing from the image, all repos silently fall back to defaults.

## Testing conventions

- Tests use Vitest with ESM (`"type": "module"` in package.json)
- `src/__tests__/setup.js` sets all required env vars before each test file runs (no `.env` file needed for tests); `ANTHROPIC_API_KEY` is intentionally not set there — the Claude adapter is mocked in tests
- External dependencies (`@octokit/auth-app`, `@octokit/rest`, `bullmq`, `ioredis`, `@anthropic-ai/sdk`) are always mocked — no live Redis, GitHub API, or Anthropic API calls in tests
- `processJob` and `dispatch` are exported specifically to enable unit testing without live infrastructure
- Tests import modules with `await import(...)` after setting up `vi.mock()` calls to handle ESM module caching
- The `@anthropic-ai/sdk` mock uses a regular `function` constructor (not an arrow function) because `new Anthropic()` must be constructable
