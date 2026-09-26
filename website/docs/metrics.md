# Metrics

Layne can expose Prometheus metrics for operational and security visibility. Metrics are disabled by default and opt-in via environment variable. No Prometheus or Grafana infrastructure is required for a basic deployment.

## Enabling metrics

Set `METRICS_ENABLED=true` in your environment (or `.env` file). The worker will start a lightweight HTTP server on `METRICS_PORT` (default: `9091`); the server exposes an additional `GET /metrics` endpoint on its existing port.

| Variable | Default | Description |
|----------|---------|-------------|
| `METRICS_ENABLED` | `false` | Set to `true` to enable Prometheus metrics |
| `METRICS_PORT` | `9091` | Port for the worker metrics HTTP server |


## Available metrics

**Operational**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `layne_scans_total` | Counter | `conclusion`, `owner`, `repo` | Completed scans |
| `layne_scan_duration_seconds` | Histogram | `conclusion` | End-to-end scan duration |
| `layne_scan_timeouts_total` | Counter | (none) | Scans killed by the configured job timeout |
| `layne_scan_retries_total` | Counter | (none) | Jobs that were retried |
| `layne_queue_waiting` | Gauge | (none) | Jobs waiting in the BullMQ queue |
| `layne_queue_active` | Gauge | (none) | Jobs currently processing |
| `layne_queue_failed` | Gauge | (none) | Jobs in the failed state |
| `layne_webhooks_total` | Counter | `action`, `deduplicated` | Webhook events received |

**Security / product**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `layne_findings_total` | Counter | `severity`, `tool`, `owner`, `repo` | Cumulative findings across all scans |
| `layne_finding_placements_total` | Counter | `tool`, `outcome`, `reason` | Inline finding placement outcomes |
| `layne_findings_per_scan` | Histogram | `conclusion` | Distribution of findings count per scan |

**Spectre**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `layne_spectre_scans_total` | Counter | `provider`, `outcome`, `reason` | Complete, incomplete, and disabled scan outcomes with bounded reasons |
| `layne_spectre_provider_request_duration_seconds` | Histogram | `provider`, `outcome` | Provider request latency and terminal request outcome |
| `layne_spectre_provider_input_bytes` | Histogram | `provider` | System plus user prompt bytes observed for provider requests |
| `layne_spectre_chunks_total` | Counter | `provider`, `outcome` | Chunk completion, failure, invalid response, cancellation, rate/concurrency denial, and circuit-open outcomes |
| `layne_spectre_governor_decisions_total` | Counter | `provider`, `backend`, `outcome`, `reason` | Acquired or denied governor decisions |
| `layne_spectre_provider_failures_total` | Counter | `kind` | Pi AI transport failures classified as authentication/configuration, provider rate limit, provider 5xx, timeout, connection, or unknown |
| `layne_spectre_inflight_requests` | Gauge | (none) | Pi AI provider requests currently in flight in this process |
| `layne_spectre_governor_inflight_requests` | Gauge | `provider`, `backend` | Requests holding provider governor leases |
| `layne_spectre_circuit_state` | Gauge | `provider`, `backend` | Circuit state: `0` closed, `1` open, `2` half-open |
| `layne_spectre_governor_lease_recoveries_total` | Counter | `provider`, `backend` | Expired Redis leases recovered during acquisition |
| `layne_spectre_governor_backend_errors_total` | Counter | `provider`, `backend`, `operation` | Redis governor backend operation failures |
| `layne_spectre_cache_operations_total` | Counter | `operation`, `outcome`, `result` | Cache reads, writes, served hits, verification comparisons, invalidations, conflicts, budget rejection, and backend errors |
| `layne_spectre_cache_entry_bytes` | Histogram | (none) | Serialized cache envelope size for successful writes |
| `layne_spectre_structural_files_total` | Counter | `mode`, `outcome` | Files processed by structural routing, using bounded parser/worker outcomes |
| `layne_spectre_structural_duration_seconds` | Histogram | `mode`, `outcome` | Structural routing analysis latency |
| `layne_spectre_structural_input_bytes` | Histogram | `mode` | UTF-8 source bytes parsed structurally |
| `layne_spectre_structural_facts` | Histogram | `mode` | Structural facts produced per routing operation |
| `layne_spectre_structural_selection_delta` | Histogram | `mode`, `direction` | Files added to or removed from augmented selection compared with lexical selection |

Use `layne_spectre_scans_total` as the source of truth for Spectre rollout coverage rates. The bounded reason `high-risk-file-cap-exceeded` means score-12-or-higher files remained unscanned and the Check Run failed. Other incomplete Spectre reasons normally produce `neutral` without a blocking finding. `layne_scans_total{conclusion="neutral"}` is broader: it includes incomplete outcomes from any adapter as well as incomplete Git preparation or diff-projection coverage. There is currently no general per-adapter status metric for scanners other than Spectre; their bounded reason codes appear in the Check Run summary and operational logs.

Node.js process metrics (heap, GC, event loop lag) are also collected automatically via `prom-client`'s `collectDefaultMetrics`.

The `owner` and `repo` labels create one time series per repository. For a self-hosted app scanning a known, bounded set of repos, this is fine and genuinely useful.


## Deploying with Prometheus and Grafana

The `monitoring/` directory contains ready-to-use configuration. Use the `monitoring` Docker Compose profile to bring up the full stack:

```bash title="Terminal"
METRICS_ENABLED=true docker compose --profile monitoring up
```

This starts:
- **Prometheus** - scrapes both the server (`:3000/metrics`) and the worker (`:9091/metrics`) every 15 seconds. Data is retained for 30 days in a named Docker volume.
- **Grafana** - available at `http://localhost:3001`, pre-provisioned with the Prometheus datasource and a Layne dashboard. No manual setup required.

The Grafana dashboard (`monitoring/grafana/dashboards/layne.json`) includes panels for:
- Scan rate by conclusion
- Scan duration (p50 / p95)
- Findings by severity over time
- Queue depth (waiting / active / failed)
- Timeouts and retries
- Webhook rate and deduplication
- Top repos by finding count (last 24 h)
- Findings distribution per scan
- Spectre complete/incomplete rate by provider
- Spectre incomplete reasons
- Spectre provider p95 request latency and chunk outcomes
- Spectre governor denials and circuit state
- Spectre Redis backend errors and expired-lease recoveries

Prometheus loads `monitoring/prometheus-rules.yml`, which defines:

| Alert | Condition |
|---|---|
| `LayneSpectreSustainedIncompleteRate` | More than 20% incomplete over a 15-minute window with at least 5 scans, sustained for 10 minutes |
| `LayneSpectreProviderFailureSpike` | At least 5 failed or invalid provider chunks in 10 minutes for one provider, sustained for 5 minutes |
| `LayneSpectreGovernorDenialSpike` | At least 10 non-cancellation denials in 10 minutes by provider/backend/reason, sustained for 5 minutes |
| `LayneSpectreCircuitOpen` | A provider/backend circuit remains open for 5 minutes |
| `LayneSpectreRedisGovernorErrors` | At least 3 Redis governor errors in 10 minutes by provider/operation, sustained for 5 minutes |
| `LayneSpectreLeaseRecoveryAnomaly` | At least 5 expired Redis lease recoveries in 15 minutes for one provider, sustained for 5 minutes |

Prometheus evaluates these rules, but the supplied stack does not configure an Alertmanager notification destination. Connect Alertmanager or your existing Prometheus-compatible alerting system before relying on notifications. Observe all six alerts and the provider rates before considering Spectre's documented [fail-closed promotion gate](scanners/spectre.md#rollout-gate).

:::warning
For production, Prometheus and Grafana should sit behind the same Nginx reverse proxy as the rest of Layne, or on an internal network not exposed to the public internet. Neither service has authentication enabled in the default configuration.
:::
