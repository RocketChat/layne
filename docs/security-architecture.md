# Security Architecture

This document describes Layne's own security posture — the permissions it holds, how credentials are handled, what the exposure looks like if something is compromised, and what to do about it.

---

## GitHub App Permissions

Layne requests the minimum permissions needed to do its job:

| Permission | Level | Why |
|---|---|---|
| Checks | Read & write | Creates and updates Check Runs with scan results and annotations |
| Contents | Read-only | Clones the PR head and base commits to scan changed files |
| Pull requests | Read-only | Reads PR metadata (number, head SHA, base SHA) from the webhook payload |
| Issues | Read & write | Adds and removes GitHub labels on PRs (labels are managed via the Issues API) |

Layne does not request write access to Contents, code, or settings — it cannot push commits or modify repository configuration.

---

## Credential Handling

### GitHub private key (`GITHUB_APP_PRIVATE_KEY`)

The RSA private key is used to sign short-lived JWTs, which are then exchanged for **installation access tokens** scoped to a single GitHub App installation. These tokens:
- Expire after 1 hour
- Are generated fresh per scan job
- Are never written to disk or logged
- Are scoped only to the repositories where Layne is installed

The private key itself lives only in the process environment. It is never written to disk by Layne.

### Webhook secret (`GITHUB_WEBHOOK_SECRET`)

Every inbound webhook is verified against an HMAC-SHA256 signature before any processing occurs. Requests that fail signature verification are rejected with `401` and logged. No job is enqueued and no GitHub API call is made.

### Anthropic API key (`ANTHROPIC_API_KEY`)

Used only when a repo has `claude.enabled: true`. The key is passed directly to the Anthropic SDK — it is not stored in Redis or logged. File contents from changed PRs are sent to the Anthropic API for analysis when the Claude scanner is enabled; see [Data in Transit](#data-in-transit).

### Notification webhook URLs (`webhookUrl`)

Rocket.Chat webhook URLs can be stored as environment variable references (e.g. `"$ROCKETCHAT_WEBHOOK_URL"`) in `repos.json` rather than as plaintext values. Layne resolves them at runtime from `process.env`. This keeps secrets out of the repository.

---

## Data in Transit

### Code sent to Anthropic

When the Claude scanner is enabled for a repo, the content of changed source files is sent to the Anthropic API. Files are batched at 100 KB per call and capped at 50 KB per individual file. Binary files are skipped.

**Implications:**
- Source code leaves your environment and is processed by Anthropic's infrastructure.
- This applies to all files changed in the PR, not just the lines changed.
- If your repositories contain sensitive business logic or regulated data, consider whether enabling the Claude scanner is appropriate, or use a highly scoped custom prompt.
- Skill mode (API Skills beta) is explicitly not ZDR (Zero Data Retention) eligible.

### Code sent to Semgrep and Trufflehog

These tools run **locally** inside the Docker container. No code is sent to external services.

---

## Network Exposure

The EC2 instance exposes:
- **Port 443 (HTTPS)** — inbound from anywhere; receives GitHub webhooks
- **Port 80 (HTTP)** — inbound from anywhere; used only for ACME certificate challenges during TLS issuance/renewal
- **Port 22 (SSH)** — restrict to your IP only
- **Port 9091 (metrics)** — internal only; do not expose publicly. The Prometheus metrics endpoint has no authentication.

---

## Data Retention

| Data | Where stored | Retention |
|---|---|---|
| Scan job queue | Redis | Until job completes or fails; evicted by BullMQ |
| Notification dedup counts | Redis (`layne:scan:count:…`) | 30-day TTL |
| Cloned repository workspaces | Ephemeral temp directory | Deleted in `finally` block after each scan |
| Scan findings | Not stored | Results are posted directly to the GitHub Check Run and discarded |

Layne does not maintain a database of findings. If Redis is lost, the only consequence is that notifications may re-fire for PRs that were previously notified (because the dedup counter is reset to zero).

---

## Compromise Scenarios

### Webhook secret leaked

**Impact:** An attacker could forge webhook payloads, causing Layne to scan arbitrary refs on repos where it is installed, or to create spurious Check Runs. This could waste compute, produce confusing results, or trigger notifications. The attacker cannot read repository contents or modify code.

**Response:**
1. Go to the GitHub App settings → **Webhook secret** → regenerate.
2. Update `GITHUB_WEBHOOK_SECRET` in your `.env` and secrets store.
3. Redeploy the server container.

### GitHub App private key leaked

**Impact:** An attacker with the private key can generate installation tokens for any installation of the app, then use those tokens to read repository contents and write Check Runs — at the level of Layne's declared permissions. They cannot exceed those permissions (no write access to code, no admin access).

**Response:**
1. Go to the GitHub App settings → **Private keys** → generate a new key, then delete the compromised one. Old tokens signed with the revoked key stop working immediately.
2. Update `GITHUB_APP_PRIVATE_KEY` in your `.env` and secrets store.
3. Redeploy both containers.

### Anthropic API key leaked

**Impact:** An attacker can make Anthropic API calls billed to your account.

**Response:** Rotate the key in the Anthropic console and update `ANTHROPIC_API_KEY` in your `.env` and secrets store.

---

## Scanner Isolation

Semgrep and Trufflehog run as subprocesses inside the worker container via `execFile` (not a shell). Arguments are passed as an array, so shell injection through file paths or config values is not possible.

The worker container has no outbound network restrictions by default. Semgrep's `--config auto` fetches rules from the internet; Trufflehog's `--no-update` flag prevents version checks but does not restrict its scanning behaviour. If your threat model requires network isolation, configure Docker network policies accordingly.

---

## Reporting a Vulnerability in Layne

See [SECURITY.md](../SECURITY.md).
