# Metrics

Layne can expose Prometheus metrics for operational and security visibility. Metrics are **disabled by default** and opt-in via environment variable — no Prometheus or Grafana infrastructure is required for a basic deployment.

---

## Enabling metrics

Set `METRICS_ENABLED=true` in your environment (or `.env` file). The worker will start a lightweight HTTP server on `METRICS_PORT` (default: `9091`); the server exposes an additional `GET /metrics` endpoint on its existing port.

| Variable | Default | Description |
|----------|---------|-------------|
| `METRICS_ENABLED` | `false` | Set to `true` to enable Prometheus metrics |
| `METRICS_PORT` | `9091` | Port for the worker metrics HTTP server |

---

## Available metrics

**Operational**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `layne_scans_total` | Counter | `conclusion`, `owner`, `repo` | Completed scans |
| `layne_scan_duration_seconds` | Histogram | `conclusion` | End-to-end scan duration |
| `layne_scan_timeouts_total` | Counter | — | Scans killed by the 10-minute timeout |
| `layne_scan_retries_total` | Counter | — | Jobs that were retried |
| `layne_queue_waiting` | Gauge | — | Jobs waiting in the BullMQ queue |
| `layne_queue_active` | Gauge | — | Jobs currently processing |
| `layne_queue_failed` | Gauge | — | Jobs in the failed state |
| `layne_webhooks_total` | Counter | `action`, `deduplicated` | Webhook events received |

**Security / product**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `layne_findings_total` | Counter | `severity`, `tool`, `owner`, `repo` | Cumulative findings across all scans |
| `layne_findings_per_scan` | Histogram | `conclusion` | Distribution of findings count per scan |

Node.js process metrics (heap, GC, event loop lag) are also collected automatically via `prom-client`'s `collectDefaultMetrics`.

> **On cardinality:** `owner` and `repo` labels create one time series per repository. For a self-hosted app scanning a known, bounded set of repos this is fine and genuinely useful.

---

## Deploying with Prometheus and Grafana

The `monitoring/` directory contains ready-to-use configuration. Use the `monitoring` Docker Compose profile to bring up the full stack:

```bash
METRICS_ENABLED=true docker compose --profile monitoring up
```

This starts:
- **Prometheus** — scrapes both the server (`:3000/metrics`) and the worker (`:9091/metrics`) every 15 seconds. Data is retained for 30 days in a named Docker volume.
- **Grafana** — available at `http://localhost:3001`, pre-provisioned with the Prometheus datasource and a Layne dashboard. No manual setup required.

The Grafana dashboard (`monitoring/grafana/dashboards/layne.json`) includes panels for:
- Scan rate by conclusion
- Scan duration (p50 / p95)
- Findings by severity over time
- Queue depth (waiting / active / failed)
- Timeouts and retries
- Webhook rate and deduplication
- Top repos by finding count (last 24 h)
- Findings distribution per scan

For production, Prometheus and Grafana should sit behind the same Nginx reverse proxy as the rest of Layne, or on an internal network not exposed to the public internet.
