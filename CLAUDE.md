# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Layne is a self-hosted GitHub App that centralises security scanning across repositories. It receives `pull_request` webhooks, enqueues scan jobs via BullMQ/Redis, posts results back as GitHub Check Run annotations, manages PR labels, and sends chat notifications. It runs three scanners: Semgrep (SAST), Trufflehog (secret detection), and Claude (malicious intent detection).

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

# Lint
npm run lint
```

## Environment variables

Required (checked at startup by `validateEnv()` in `src/env.js`):
```
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY   # single-line PEM with literal \n between lines
GITHUB_WEBHOOK_SECRET
```

Optional:
```
REDIS_URL                # defaults to redis://localhost:6379
PORT                     # defaults to 3000
ANTHROPIC_API_KEY        # required when any repo has claude.enabled: true
METRICS_ENABLED          # set to "true" to enable Prometheus metrics
METRICS_PORT             # worker metrics server port, defaults to 9091
DOMAIN                   # used for Rocket.Chat icon_url and TLS
DEBUG_MODE               # set to "true" for verbose logging
```

## Architecture

Two separate Node.js processes:

**`src/server.js` — Webhook receiver**
- Express app with `POST /webhook`, `GET /health`, `GET /metrics` (when enabled), `GET /assets/layne-logo.png`
- Verifies GitHub HMAC signature before processing
- On a qualifying `pull_request` event (opened/synchronize/reopened), creates a GitHub Check Run in `queued` state, then enqueues a BullMQ job and returns 200
- Job ID is deduplicated by `{repo}#{pr}@{sha}` — duplicate webhook deliveries are no-ops (Redis lock + queue check)
- Exported `app` and `processWebhookRequest` for use in tests

**`src/worker.js` — Job processor**
- BullMQ `Worker` consuming the `scans` queue with concurrency 5
- `processJob()` is exported for direct testing without Redis
- Per-job 10-minute timeout via `Promise.race`
- Graceful shutdown on SIGTERM/SIGINT — finishes in-flight jobs before exiting
- When `METRICS_ENABLED=true`: starts an HTTP metrics server on `METRICS_PORT` and polls BullMQ queue counts every 15 s

**Job lifecycle (inside `runScan`):**
1. Mark Check Run `in_progress`
2. Authenticate as installation via `src/auth.js` → short-lived token
3. Create temp workspace (`src/fetcher.js` → `createWorkspace`)
4. Partial-clone both head and base SHAs with `--filter=blob:none` — fetches trees/commits only, no blobs yet (`src/fetcher.js` → `setupRepo`)
5. Diff the two commits via tree objects to get changed file paths (`getChangedFiles`)
6. Sparse-checkout only the changed files — blobs fetched on demand (`checkoutFiles`)
7. Load per-repo config via `src/config.js` → `loadScanConfig`
8. Run scanners in parallel via `src/dispatcher.js` → `dispatch()`
9. Convert findings to annotations via `src/reporter.js` → `buildAnnotations()`
10. Complete Check Run
11. Apply/remove PR labels via `src/github.js` → `ensureLabelsExist` + `setLabels`
12. Notify via `src/notifiers/index.js` → `notify()` (only when finding count increases)
13. Clean up workspace in `finally`

**Scanners (`src/adapters/`):**
- `semgrep.js` — runs `semgrep scan --config auto --json`; exit code 1 = findings found (not an error); maps ERROR→high, WARNING→medium, INFO→low
- `trufflehog.js` — runs `trufflehog filesystem --json --no-update`; exit code 183 = secrets found (not an error); batched at 200 files to stay under ARG_MAX; all findings are severity `high`
- `claude.js` — calls the Anthropic API to detect malicious intent; **disabled by default**, opt in per repo; skips binary files; caps files at 50 KB; batches at 100 KB per API call; errors are caught and logged without failing the scan. Supports two modes (configured per-repo in `repos.json`):
  - **Prompt mode** (default): single `messages.create` call with a system prompt; use `claude.prompt` to override
  - **Skill mode**: uses the Anthropic [API Skills beta](https://platform.claude.com/docs/en/build-with-claude/skills-guide) — adds a `code_execution` tool + an uploaded skill to each batch call, enabling runtime decoding, registry lookups, and richer static analysis; set `claude.skill: { id, version }` to enable; handles `pause_turn` continuations automatically (up to 10 turns per batch)

**Common finding shape:**
```js
{ file, line, severity, message, ruleId, tool }
```

**Severity → GitHub annotation level:**
- `critical` / `high` → `failure` (blocks merge)
- `medium` → `warning`
- `low` / `info` → `notice`

**GitHub Check Run annotations** are chunked at 50 per API call (GitHub API limit), with `status: completed` set only on the last chunk.

## Key modules

| Module | Purpose |
|--------|---------|
| `src/config.js` | Loads and merges `config/repos.json`; cached after first read |
| `src/github.js` | Check Run CRUD + label management (`ensureLabelsExist`, `setLabels`) |
| `src/metrics.js` | Prometheus metric definitions; exports no-op stubs when `METRICS_ENABLED` is not `true` |
| `src/notifiers/index.js` | Notification orchestrator; iterates registered notifiers |
| `src/notifiers/rocketchat.js` | Rocket.Chat incoming webhook notifier |
| `src/queue.js` | Shared Redis + BullMQ queue instance |
| `src/debug.js` | Conditional debug logging via `DEBUG_MODE` |

## Per-repo configuration (`config/repos.json`)

Keyed by `"owner/repo"`. Read once at worker startup — **restart the worker to pick up changes**.

Supports a reserved `$global` key for defaults inherited by all repos:

```json
{
  "$global": {
    "notifications": { "rocketchat": { "enabled": true, "webhookUrl": "$ROCKETCHAT_WEBHOOK_URL" } },
    "labels": { "onFailure": ["needs-security-review"], "removeOnSuccess": ["needs-security-review"] }
  },
  "owner/repo": {
    "semgrep":       { "enabled": true, "extraArgs": ["--config", "p/owasp-top-ten"] },
    "trufflehog":    { "enabled": true, "extraArgs": ["--only-verified"] },
    "claude":        { "enabled": true, "model": "claude-haiku-4-5-20251001" },
    "notifications": { "rocketchat": { "enabled": true, "webhookUrl": "$REPO_HOOK" } },
    "labels":        { "onFailure": ["security-critical"], "removeOnSuccess": ["security-critical"] }
  }
}
```

**Claude scanner modes:**

Prompt mode — custom system prompt, works with any model:
```json
"claude": { "enabled": true, "model": "claude-haiku-4-5-20251001", "prompt": "You are a..." }
```

Skill mode — uses an uploaded Anthropic API Skill (beta); `prompt` is ignored when `skill` is set:
```json
"claude": { "enabled": true, "model": "claude-opus-4-6", "skill": { "id": "skill_01...", "version": "latest" } }
```

To upload a skill, point `files_from_dir` at a folder containing a `SKILL.md` and run once:
```python
from anthropic import Anthropic
from anthropic.lib import files_from_dir

skill = Anthropic().beta.skills.create(
    display_title="My Skill",
    files=files_from_dir("/path/to/skill-folder"),
    betas=["skills-2025-10-02"],
)
print(skill.id)  # skill_01...
```

Merge rules:
- Scanner blocks: per-repo spread over defaults (`{ ...DEFAULT_CONFIG.semgrep, ...repoOverrides.semgrep }`)
- `notifications` and `labels`: per-repo notifier/key wins over global; per-repo absence = inherit global entirely
- `extraArgs` fully replaces the default (not extended)
- `config/repos.json` must be present in the Docker image (`COPY config/ ./config/`)

## Notifications

- Implemented in `src/notifiers/` — modular, one file per provider
- Notifier contract: `async function notify({ findings, owner, repo, prNumber, toolConfig })` — must never throw
- Deduplication: notify only when `findings.length > prevCount` (stored in Redis key `layne:scan:count:{owner}/{repo}#{prNumber}`, 30-day TTL)
- `webhookUrl` values starting with `$` are resolved from `process.env` at runtime

## Labels

- `ensureLabelsExist` creates missing labels with color `#ededed` before applying them
- `setLabels` adds/removes labels; 404 on remove = already absent = silently ignored
- Label errors never affect the scan result or Check Run

## Metrics

- `src/metrics.js` exports real prom-client objects when `METRICS_ENABLED=true`, silent no-op stubs otherwise
- No `if (METRICS_ENABLED)` guards needed at call sites — stubs absorb all calls
- Worker: metrics HTTP server + BullMQ queue poller (15 s interval) started only when enabled
- Server: `GET /metrics` route registered only when enabled
- `monitoring/` directory has Prometheus scrape config and a pre-built Grafana dashboard

## Testing conventions

- Tests use Vitest with ESM (`"type": "module"` in package.json)
- `src/__tests__/setup.js` sets all required env vars before each test file; `ANTHROPIC_API_KEY` and `METRICS_ENABLED` are intentionally not set — adapters and metrics are mocked
- External dependencies (`@octokit/auth-app`, `@octokit/rest`, `bullmq`, `ioredis`, `@anthropic-ai/sdk`, `prom-client`) are always mocked — no live connections in tests
- `src/metrics.js` is mocked in worker and server tests with `vi.fn()` stubs; tested in isolation in `src/__tests__/metrics.test.js`
- `processJob` and `dispatch` are exported specifically for unit testing without live infrastructure
- Tests import modules with `await import(...)` after `vi.mock()` calls to handle ESM module caching
- The `@anthropic-ai/sdk` mock uses a regular `function` constructor (not an arrow function) because `new Anthropic()` must be constructable
