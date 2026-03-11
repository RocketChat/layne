# Reference

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GITHUB_APP_ID` | Yes | — | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | Yes | — | RSA private key (single line, `\n`-escaped) |
| `GITHUB_WEBHOOK_SECRET` | Yes | — | HMAC secret for webhook signature verification |
| `REDIS_URL` | Yes | `redis://localhost:6379` | Redis connection string (set automatically in Docker Compose) |
| `DOMAIN` | Yes | — | Domain name for TLS and the Rocket.Chat logo URL (e.g. `layne.example.com`) |
| `LETSENCRYPT_EMAIL` | Yes | — | Email for Let's Encrypt expiry notifications |
| `PORT` | No | `3000` | Port for the webhook server |
| `ANTHROPIC_API_KEY` | No | — | Required when any repo has `claude.enabled: true` |
| `DEBUG_MODE` | No | off | Set to `true` or `1` to enable verbose debug logging |
| `METRICS_ENABLED` | No | `false` | Set to `true` to enable Prometheus metrics endpoints |
| `METRICS_PORT` | No | `9091` | Port for the worker Prometheus metrics server |
| `ROCKETCHAT_WEBHOOK_URL` | No | — | Global Rocket.Chat webhook URL, referenced as `"$ROCKETCHAT_WEBHOOK_URL"` in `config/repos.json`. Add additional vars (e.g. `PAYMENTS_ROCKETCHAT_WEBHOOK_URL`) for per-repo webhooks. |

## Finding Shape

All scanners produce findings in a common format:

```js
{
  file:     'src/app.js',      // repo-root-relative path
  line:     42,                // line number
  severity: 'high',            // 'critical' | 'high' | 'medium' | 'low'
  message:  'SQL injection',   // annotation body text
  ruleId:   'semgrep/rule-id', // stable rule identifier
  tool:     'semgrep',         // scanner name
}
```

## Severity → GitHub annotation level

| Severity | GitHub level | Effect |
|---|---|---|
| `critical` | `failure` | Blocks merge |
| `high` | `failure` | Blocks merge |
| `medium` | `warning` | Visible warning |
| `low` | `notice` | Informational |

## Scan timeout

Each job has a hard 10-minute timeout. If a scan exceeds this limit:
- The job is rethrown so BullMQ can retry it
- The Check Run is only marked as failed on the **final** attempt (not on intermediate retries)
- `layne_scan_timeouts_total` is incremented (when metrics are enabled)

## Webhook deduplication

Duplicate webhook deliveries (same repo + PR number + commit SHA) are ignored using a Redis lock with a 30-second TTL. This prevents double-scanning when GitHub retries a delivery.

## Queue

Layne uses [BullMQ](https://docs.bullmq.io/) backed by Redis. The queue is named `scans`. Each worker process runs with a concurrency of 5 (5 simultaneous jobs). Scale horizontally by running additional worker containers — they all share the same Redis queue.

Jobs are configured with 2 attempts. On the first failure, BullMQ retries automatically; on the second failure the job is moved to the failed set and the Check Run is marked as `failure`.
