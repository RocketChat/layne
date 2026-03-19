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
| `ANTHROPIC_API_KEY` | No | (none) | Required when any repo has `claude.enabled: true` |
| `DEBUG_MODE` | No | off | Set to `true` or `1` to enable verbose debug logging |
| `METRICS_ENABLED` | No | `false` | Set to `true` to enable Prometheus metrics endpoints |
| `METRICS_PORT` | No | `9091` | Port for the worker Prometheus metrics server |
| `ROCKETCHAT_WEBHOOK_URL` | No | (none) | Global Rocket.Chat webhook URL, referenced as `"$ROCKETCHAT_WEBHOOK_URL"` in `config/layne.json`. Add additional vars (e.g. `PAYMENTS_ROCKETCHAT_WEBHOOK_URL`) for per-repo webhooks. |

## Finding Shape

All scanners produce findings in a common format:

```js
{
  file:     'src/app.js',      // repo-root-relative path
  severity: 'high',            // 'critical' | 'high' | 'medium' | 'low' | 'info'
  line:     42,                // line number
  message:  'SQL injection',   // annotation body text
  ruleId:   'semgrep/rule-id', // stable rule identifier
  tool:     'semgrep',         // scanner name
}
```

For how findings are converted to GitHub annotations and how severities affect PR status, see [Extending Layne - How Findings Become GitHub Annotations](extending.md#how-findings-become-github-annotations).

## Scan timeout

Each job has a hard 10-minute timeout. If a scan exceeds this limit:
- The job is rethrown so BullMQ can retry it
- The Check Run is only marked as failed on the **final** attempt (not on intermediate retries)
- `layne_scan_timeouts_total` is incremented (when metrics are enabled)

## Webhook deduplication

Duplicate webhook deliveries (same repo + PR number + commit SHA) are ignored using a Redis lock with a 30-second TTL. This prevents double-scanning when GitHub retries a delivery.

## Queue

Layne uses [BullMQ](https://docs.bullmq.io/) backed by Redis. The queue is named `scans`. Each worker process runs with a concurrency of 5 (5 simultaneous jobs). Scale horizontally by running additional worker containers - they all share the same Redis queue.

Jobs are configured with 2 attempts. On the first failure, BullMQ retries automatically; on the second failure the job is moved to the failed set and the Check Run is marked as `failure`.
