# Reference
## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GITHUB_APP_ID` | Yes | (none) | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | Yes | (none) | RSA private key (single line, `\n`-escaped) |
| `GITHUB_WEBHOOK_SECRET` | Yes | (none) | HMAC secret for webhook signature verification |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection string (set automatically in Docker Compose) |
| `DOMAIN` | No* | (none) | Domain name for TLS and the Rocket.Chat logo URL (e.g. `layne.example.com`). Required by the Docker Compose TLS setup - not validated at runtime by the app. |
| `LETSENCRYPT_EMAIL` | No* | (none) | Email for Let's Encrypt expiry notifications. Required by the Docker Compose TLS setup - not validated at runtime by the app. |
| `PORT` | No | `3000` | Port for the webhook server |
| `ANTHROPIC_API_KEY` | No | (none) | Required when any repo has `claude.enabled: true`, or when Spectre is configured with `provider: "anthropic"` |
| `OPENAI_API_KEY` | No | (none) | Required when Spectre uses `provider: "openai"` |
| `GEMINI_API_KEY` | No | (none) | Required when Spectre uses `provider: "google"` |
| `MISTRAL_API_KEY` | No | (none) | Required when Spectre uses `provider: "mistral"` |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | No | (none) | One region variable is required when Spectre uses `provider: "amazon-bedrock"` |
| `AWS_BEARER_TOKEN_BEDROCK` or AWS credential chain | No | (none) | Bedrock authentication. Static IAM credentials, profiles, and instance/task roles are also supported by the standard AWS credential chain |
| `SPECTRE_GOVERNOR_BACKEND` | No | `in_process` | Spectre provider governor backend. Set to `redis` for deployment-wide limits across worker processes |
| `SPECTRE_GLOBAL_CONCURRENCY` | No | `4` | Provider-scoped concurrency limit; hard maximum `100` |
| `SPECTRE_REQUESTS_PER_MINUTE` | No | `35` | Provider-scoped sustained request rate; hard maximum `10000` |
| `SPECTRE_REQUEST_BURST` | No | min(`35`, RPM) | Provider-scoped burst, never greater than configured RPM |
| `SPECTRE_QUEUE_TIMEOUT_MS` | No | `2000` | Governor concurrency wait; hard maximum `60000` |
| `SPECTRE_CIRCUIT_FAILURES` | No | `3` | Retryable failures needed to open a provider circuit; hard maximum `100` |
| `SPECTRE_CIRCUIT_WINDOW_SECONDS` | No | `60` | Failure counting window; hard maximum `3600` |
| `SPECTRE_CIRCUIT_COOLDOWN_SECONDS` | No | `60` | Open-circuit cooldown; hard maximum `3600` |
| `SPECTRE_CACHE_MODE` | No | `off` | Response cache mode: `off`, `write-only`, `verify`, or `read-write` |
| `SPECTRE_CACHE_HMAC_KEY` | Conditional | (none) | Required outside `off`; at least 32 random bytes used to sign cache envelopes. Use a dedicated production secret |
| `SPECTRE_CACHE_MAX_BYTES` | Conditional | (none) | Required outside `off`; cache-only byte budget from 1 MiB through 1 GiB |
| `SPECTRE_CACHE_EPOCH` | No | `1` | Change to invalidate all existing Spectre cache identities |
| `SPECTRE_CACHE_REDIS_URL` | No | `REDIS_URL` | Optional cache-specific Redis endpoint. The bundled deployment initially shares Redis through a dedicated bounded client |
| `LAYNE_BUILD_SHA` | Conditional | (none) | Required outside `off`; immutable deployment build identity included in cache keys |
| `DEBUG_MODE` | No | off | Set to `true` or `1` to enable verbose debug logging |
| `METRICS_ENABLED` | No | `false` | Set to `true` to enable Prometheus metrics endpoints |

| `METRICS_PORT` | No | `9091` | Port for the worker Prometheus metrics server |
| `ROCKETCHAT_WEBHOOK_URL` | No | (none) | Global Rocket.Chat webhook URL, referenced as `"$ROCKETCHAT_WEBHOOK_URL"` in `config/layne.json`. Add additional vars (e.g. `PAYMENTS_ROCKETCHAT_WEBHOOK_URL`) for per-repo webhooks. |

The Spectre evaluator variables are intentionally not production settings. They are documented with the manual commands, thresholds, credential implications, and source-data implications on the [Spectre evaluation](scanners/spectre.md#evaluation) page. The Codex evaluator is manual-only and refuses to run in CI or tests.

## Finding Shape

All scanners produce findings in a common format:

```ts
{
  file:     'src/app.js',      // repo-root-relative path
  severity: 'high',            // 'critical' | 'high' | 'medium' | 'low' | 'info'
  line:     42,                // line number
  message:  'SQL injection',   // annotation body text
  ruleId:   'semgrep/rule-id', // stable rule identifier
  tool:     'semgrep',         // Tool union member
}
```

For how findings are converted to GitHub annotations and how severities affect PR status, see [Extending Layne - How Findings Become GitHub Annotations](extending.md#how-findings-become-github-annotations).

## Adapter Result Shape

Every dispatcher adapter returns findings and an explicit status:

```ts
type AdapterOutcome = 'complete' | 'incomplete' | 'disabled';

interface AdapterStatus {
  outcome: AdapterOutcome;
  reason?: string;
}

interface AdapterResult<
  Finding extends RawFinding = RawFinding,
  Status extends AdapterStatus = AdapterStatus,
> {
  findings: Finding[];
  status: Status;
}

interface DispatchResult {
  findings: RawFinding[];
  statuses: AdapterStatuses;
}
```

`reason` is an optional stable code suitable for summaries and bounded telemetry. Raw provider, command, and exception messages belong in logs only. An incomplete result may contain valid partial findings; those findings remain eligible for validation, suppression, annotations, comments, and notifications. Most incomplete results make an otherwise-successful Check Run neutral. Spectre's bounded `high-risk-file-cap-exceeded` reason is intentionally blocking because its selected-file caps left score-12-or-higher files unscanned; it does not fabricate a finding.

Only results whose `status.outcome` is `complete` are safe to reuse as complete scan results. If adapter-result caching is introduced, `incomplete` and `disabled` results must not be treated as reusable clean coverage.

## Scan timeout

Each job has a configurable timeout (default 15 minutes, controlled by [`timeoutMinutes`](configuration.md#timeoutminutes) in `layne.json`). If a scan exceeds this limit before its terminal Check Run is published:
- The job is rethrown so BullMQ can retry it
- The Check Run is only marked as failed on the **final** attempt (not on intermediate retries)
- `layne_scan_timeouts_total` is incremented (when metrics are enabled)

If the terminal Check Run was already published, the deadline only aborts remaining best-effort side effects; the completed job is not retried.

## Webhook deduplication

Duplicate webhook deliveries (same repo + PR number + commit SHA) are ignored using a Redis lock with a 30-second TTL. This prevents double-scanning when GitHub retries a delivery.

## Queue

Layne uses [BullMQ](https://docs.bullmq.io/) backed by Redis. The queue is named `scans`. Each worker process runs with a concurrency of 5 (5 simultaneous jobs). Scale horizontally by running additional worker containers - they all share the same Redis queue.

Jobs are configured with 2 attempts. On the first failure, BullMQ retries automatically; on the second failure the job is moved to the failed set and the Check Run is marked as `failure`.
