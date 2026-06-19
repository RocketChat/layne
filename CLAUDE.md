# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Layne is a self-hosted GitHub App that centralises security scanning across repositories. It receives `pull_request` webhooks, enqueues scan jobs via BullMQ/Redis, posts results back as GitHub Check Run annotations, manages PR labels, and sends chat notifications. It runs five scanners: Semgrep (SAST), Trufflehog (secret detection), Claude (malicious intent detection), Spectre (multi-provider LLM scanning), and Dep Doctor (dependency health).

## Commands

```bash
# Run the webhook server
npm start           # node dist/server.js

# Run the job worker
npm run worker      # node dist/worker.js

# Build TypeScript
npm run build       # tsc -p tsconfig.build.json
npm run typecheck   # tsc --noEmit

# Tests
npm test            # vitest run (single pass)
npm run test:watch  # vitest (watch mode)
npm run test:coverage

# Run a single test file
npx vitest run src/__tests__/github.test.ts

# Lint
npm run lint

# Validate config/layne.json
npm run validate-config

# Development (local)
npm run dev:server  # tsx watch src/server.ts
npm run dev:worker  # tsx watch src/worker.ts
npm run dev:redis   # docker compose up Redis for local dev
```

## Environment variables

Required (checked at startup by `validateEnv()` in `src/env.ts`):
```
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY   # single-line PEM with literal \n between lines
GITHUB_WEBHOOK_SECRET
```

Optional:
```
REDIS_URL                # defaults to redis://localhost:6379
PORT                     # defaults to 3000
ANTHROPIC_API_KEY        # required when any repo has claude.enabled: true or spectre with anthropic provider
OPENAI_API_KEY           # required when any repo uses spectre with openai provider
GEMINI_API_KEY           # required when any repo uses spectre with google provider
MISTRAL_API_KEY          # required when any repo uses spectre with mistral provider
AWS_ACCESS_KEY_ID        # required when any repo uses spectre with bedrock provider
AWS_SECRET_ACCESS_KEY    # required when any repo uses spectre with bedrock provider
AWS_REGION               # required when any repo uses spectre with bedrock provider
METRICS_ENABLED          # set to "true" to enable Prometheus metrics
METRICS_PORT             # worker metrics server port, defaults to 9091
DOMAIN                   # used for Rocket.Chat icon_url and TLS
DEBUG_MODE               # set to "true" for verbose logging
```

## Architecture

Two separate Node.js processes:

**`src/server.ts` - Webhook receiver**
- Express app with `POST /webhook`, `GET /health`, `GET /metrics` (when enabled), `GET /assets/layne-logo.png`
- Verifies GitHub HMAC signature before processing
- Handles four event types: `pull_request`, `workflow_run`, `workflow_job`, and `issue_comment`
- **`pull_request` trigger (default):** on opened/synchronize/reopened, creates a Check Run in `queued` state, enqueues a BullMQ job, returns 200
- **`workflow_run` trigger:** on `pull_request` events, caches PR metadata in Redis (TTL 7 days) and creates a `skipped` Check Run; on `workflow_run completed` events matching the configured workflow name and conclusion, looks up cached PR metadata (falls back to GitHub API if cache is cold) then enqueues the scan
- **`workflow_job` trigger:** same two-stage pattern as `workflow_run` but gates on a single named job completing rather than the whole workflow
- **`issue_comment` trigger:** parses `/layne exception-approve` commands from PR comments; validates the commenter is an authorized exception approver; stores exceptions in Redis scoped to the PR (not the commit SHA); re-enqueues the scan if the current check run is in `failure` state
- Job ID is deduplicated by `{repo}#{pr}@{sha}` - duplicate webhook deliveries are no-ops (Redis lock + queue check)
- Exported `app` and `processWebhookRequest` for use in tests

**`src/worker.ts` - Job processor**
- BullMQ `Worker` consuming the `scans` queue with concurrency 5
- `processJob()` is exported for direct testing without Redis
- Per-job 10-minute timeout via `Promise.race`
- Graceful shutdown on SIGTERM/SIGINT - finishes in-flight jobs before exiting
- When `METRICS_ENABLED=true`: starts an HTTP metrics server on `METRICS_PORT` and polls BullMQ queue counts every 15 s

**Job lifecycle (inside `runScan`):**
1. Mark Check Run `in_progress`
2. Authenticate as installation via `src/auth.ts` → short-lived token
3. Resolve merge base SHA via `src/github.ts` → `getMergeBaseSha` (three-dot diff base)
4. Create temp workspace (`src/fetcher.ts` → `createWorkspace`)
5. Partial-clone head and merge-base SHAs with `--filter=blob:none` (`src/fetcher.ts` → `setupRepo`)
6. Diff the two commits to get changed file paths (`getChangedFiles`) and per-file changed line ranges (`getChangedLineRanges`)
7. Sparse-checkout only the changed files - blobs fetched on demand (`checkoutFiles`)
8. Load per-repo config via `src/config.ts` → `loadScanConfig`
9. Run scanners in parallel via `src/dispatcher.ts` → `dispatch()`
10. Validate finding locations against the actual file content (`src/location-validator.ts` → `validateFindingLocations`)
11. Suppress findings that have a `// SECURITY:` comment at the merge base (`src/suppressor.ts` → `suppressFindings`)
12. Filter to actionable findings; stamp each with a deterministic `_findingId` (`LAYNE-xxxxxxxxxxxxxxxx`) via `src/exception-approvals.ts` → `generateFindingId`
13. Convert findings to annotations via `src/reporter.ts` → `buildAnnotations()`
14. If `exceptionApprovers` is configured: load stored exceptions from Redis (`loadExceptions`), remove stale ones whose flagged line changed (`filterStaleExceptions`), resolve approvals that survived a line-number shift via rebase (`resolveDriftedExceptions`), then call `buildExceptionSummary` to potentially override conclusion to `success`
15. Complete Check Run
16. Post PR comment if `comment.enabled` via `src/commenter.ts` → `postComment`
17. Apply/remove PR labels via `src/github.ts` → `ensureLabelsExist` + `setLabels`
18. Notify via `src/notifiers/index.ts` → `notify()` (always fires on exception approval; otherwise only when finding count increases)
19. Clean up workspace in `finally`

**Scanners (`src/adapters/`):**
- `semgrep.ts` - runs `semgrep scan --config auto --json`; exit code 1 = findings found (not an error); maps ERROR→high, WARNING→medium, INFO→low
- `trufflehog.ts` - runs `trufflehog filesystem --json --no-update`; exit code 183 = secrets found (not an error); batched at 200 files to stay under ARG_MAX; all findings are severity `high`
- `claude.ts` - calls the Anthropic API to detect malicious intent; **disabled by default**, opt in per repo; skips binary files; caps files at 50 KB; batches at 100 KB per API call; errors are caught and logged without failing the scan. Supports two modes (configured per-repo in `config/layne.json`):
  - **Prompt mode** (default): single `messages.create` call with a system prompt; use `claude.prompt` to override
  - **Skill mode**: uses the Anthropic [API Skills beta](https://platform.claude.com/docs/en/build-with-claude/skills-guide) - adds a `code_execution` tool + an uploaded skill to each batch call, enabling runtime decoding, registry lookups, and richer static analysis; set `claude.skill: { id, version }` to enable; handles `pause_turn` continuations automatically (up to 10 turns per batch)
- `spectre.ts` - malicious intent scanner; **disabled by default**, opt in per repo; makes a single direct LLM call per file (no agent session, no tools, no import following); supports Anthropic, OpenAI, Google, Mistral, and Amazon Bedrock via `@mariozechner/pi-ai`; tier-prioritised file cap (manifest/CI files always scanned first); configurable per-repo skip paths/extensions, file cap, diff line cap, min severity, and concurrency; ruleId prefix `spectre/`
- `dep-doctor.ts` - dependency health scanner; **disabled by default**, opt in per repo; only fires when a lockfile is changed by the PR; diffs the changed lockfile against the merge-base version (via `git show`) to identify newly-added packages only; runs OSV-Scanner for CVE detection (ruleId `dep-doctor/<CVE-ID>`); checks npm/PyPI registry APIs for abandoned (ruleId `dep-doctor/abandoned`) and deprecated (ruleId `dep-doctor/deprecated`) packages; supported lockfiles: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `requirements.txt`, `Pipfile.lock`, `poetry.lock`, `uv.lock`, `go.sum`; registry health checks for npm and PyPI only (Go skipped); errors caught and logged without failing the scan; requires `osv-scanner` in PATH
- `helpers.ts` - shared adapter utility functions

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
| `src/types.ts` | All TypeScript type definitions: findings, config, runtime, enums |
| `src/config.ts` | Loads and merges `config/layne.json`; cached after first read |
| `src/config-validator.ts` | Standalone config validation; also runnable via `npm run validate-config` |
| `src/scan-context.ts` | Builds `ScanContext`; implements `diff_only` mode by projecting changed hunks into `.layne/diff-only/` |
| `src/github.ts` | Check Run CRUD + label management (`ensureLabelsExist`, `setLabels`) |
| `src/metrics.ts` | Prometheus metric definitions; exports no-op stubs when `METRICS_ENABLED` is not `true` |
| `src/notifiers/index.ts` | Notification orchestrator; iterates registered notifiers |
| `src/notifiers/rocketchat.ts` | Rocket.Chat incoming webhook notifier |
| `src/notifiers/slack.ts` | Slack incoming webhook notifier |
| `src/notifiers/template.ts` | Shared template helpers: `buildContext()` and `renderTemplate()` (mustache-style `{{variable}}`) |
| `src/notifiers/types.ts` | Notifier type definitions and the `Notifier` interface contract |
| `src/queue.ts` | Shared Redis + BullMQ queue instance |
| `src/debug.ts` | Conditional debug logging via `DEBUG_MODE` |

## Per-repo configuration (`config/layne.json`)

See [website/docs/configuration.md](website/docs/configuration.md) for the full schema and examples.

Key points for code navigation:
- Read once per process startup - **restart both server and worker to pick up changes**
- Loaded and merged by `src/config.ts` → `loadScanConfig`
- Supports `$global` key for defaults inherited by all repos
- Scanner blocks: per-repo spread over defaults (`{ ...DEFAULT_CONFIG.semgrep, ...repoOverrides.semgrep }`)
- `trigger`: controls when scanning fires - `pull_request` (default, immediate) or `workflow_run` (deferred until a named CI workflow completes); global default → per-repo override
- `notifications` and `labels`: per-repo notifier/key wins over global; per-repo absence = inherit global entirely
- `extraArgs` fully replaces the default (not extended)
- `config/layne.json` must be present in the Docker image (`COPY config/ ./config/`)
- Notifier contract: `async function notify({ findings, owner, repo, prNumber, toolConfig })` - must never throw
- Notification dedup key: `layne:scan:count:{owner}/{repo}#{prNumber}` (Redis, 30-day TTL)
- `webhookUrl` values starting with `$` are resolved from `process.env` at runtime
- Label errors never affect the scan result or Check Run

## Metrics

- `src/metrics.ts` exports real prom-client objects when `METRICS_ENABLED=true`, silent no-op stubs otherwise
- No `if (METRICS_ENABLED)` guards needed at call sites - stubs absorb all calls
- Worker: metrics HTTP server + BullMQ queue poller (15 s interval) started only when enabled
- Server: `GET /metrics` route registered only when enabled
- `monitoring/` directory has Prometheus scrape config and a pre-built Grafana dashboard

## Testing conventions

- Tests use Vitest with ESM (`"type": "module"` in package.json)
- All test files are TypeScript (`.ts`); imports use `.js` extensions (NodeNext resolution)
- `src/__tests__/setup.ts` sets all required env vars before each test file; `ANTHROPIC_API_KEY` and `METRICS_ENABLED` are intentionally not set - adapters and metrics are mocked
- External dependencies (`@octokit/auth-app`, `@octokit/rest`, `bullmq`, `ioredis`, `@anthropic-ai/sdk`, `prom-client`) are always mocked - no live connections in tests
- `src/metrics.ts` is mocked in worker and server tests with `vi.fn()` stubs; tested in isolation in `src/__tests__/metrics.test.ts`
- `processJob` and `dispatch` are exported specifically for unit testing without live infrastructure
- Tests import modules with `await import(...)` after `vi.mock()` calls to handle ESM module caching
- The `@anthropic-ai/sdk` mock uses a regular `function` constructor (not an arrow function) because `new Anthropic()` must be constructable
- Typed mock call access pattern: `(mockFn as ReturnType<typeof vi.fn>).mock.calls[0] as [T1, T2]`
