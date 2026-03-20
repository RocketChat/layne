# Security Architecture

This document describes Layne's own security posture - the permissions it holds, how credentials are handled, what the exposure looks like if something is compromised, and what to do about it.

## GitHub App Permissions

Layne requests the minimum permissions needed to do its job:

| Permission | Level | Why |
|---|---|---|
| Checks | Read & write | Creates and updates Check Runs with scan results and annotations |
| Contents | Read-only | Clones the PR head and base commits to scan changed files |
| Pull requests | Read-only | Queries PR metadata via the GitHub API (`getPullRequest`, `findPullRequestBySha`) |
| Issues | Read & write | Adds and removes GitHub labels on PRs; posts exception approval confirmation and error reply comments |
| Organization members | Read-only | Resolves team membership when `exceptionApprovers.teams` is configured |

Layne does not request write access to Contents, code, or settings - it cannot push commits or modify repository configuration.


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

Used only when a repo has `claude.enabled: true`. The key is passed directly to the Anthropic SDK - it is not stored in Redis or logged. File contents from changed PRs are sent to the Anthropic API for analysis when the Claude scanner is enabled; see [Data in Transit](#data-in-transit).

### Notification webhook URLs (`webhookUrl`)

Rocket.Chat webhook URLs can be stored as environment variable references (e.g. `"$ROCKETCHAT_WEBHOOK_URL"`) in `config/layne.json` rather than as plaintext values. Layne resolves them at runtime from `process.env`. This keeps secrets out of the repository.


## Data in Transit

### Code sent to Anthropic

:::warning
When the Claude scanner is enabled, **the full content of every changed source file** is sent to the Anthropic API - not just the changed lines. Source code leaves your environment. If your repositories contain sensitive business logic, PII, or regulated data, consider whether this is appropriate before enabling Claude. Skill mode is explicitly not ZDR (Zero Data Retention) eligible.
:::

Files are batched at 100 KB per call and capped at 50 KB per individual file. Binary files are skipped. A scoped custom `prompt` can narrow the analysis surface if needed.

### Code sent to Semgrep and Trufflehog

These tools run **locally** inside the Docker container. No code is sent to external services.


## Network Exposure

The EC2 instance exposes:
- **Port 443 (HTTPS)** - inbound from anywhere; receives GitHub webhooks
- **Port 80 (HTTP)** - inbound from anywhere; used only for ACME certificate challenges during TLS issuance/renewal
- **Port 22 (SSH)** - restrict to your IP only
- **Port 9091 (metrics)** - internal only. The Prometheus metrics endpoint has no authentication - do not expose it publicly.


## Data Retention

| Data | Where stored | Retention |
|---|---|---|
| Scan job queue | Redis | Until job completes or fails; evicted by BullMQ |
| Notification dedup counts | Redis (`layne:scan:count:…`) | 30-day TTL |
| Exception approval records | Redis (`layne:exception:…`) | 30-day TTL; keyed to commit SHA so new pushes don't inherit prior approvals |
| PR metadata cache (deferred triggers) | Redis (`layne:pr:…`) | 7-day TTL |
| Cloned repository workspaces | Ephemeral temp directory | Deleted in `finally` block after each scan |
| Scan findings | Not stored | Results are posted directly to the GitHub Check Run and discarded |

Layne does not maintain a database of findings. If Redis is lost, the only consequence is that notifications may re-fire for PRs that were previously notified (because the dedup counter is reset to zero).


## Compromise Scenarios

### Webhook secret leaked

:::danger
**Impact:** An attacker can forge webhook payloads, causing Layne to scan arbitrary refs or create spurious Check Runs. Compute is wasted and notifications may fire. The attacker cannot read repository contents or modify code.
:::

**Response:**
1. Go to the GitHub App settings → **Webhook secret** → regenerate.
2. Update `GITHUB_WEBHOOK_SECRET` in your `.env` and secrets store.
3. Redeploy the server container.

### GitHub App private key leaked

:::danger
**Impact:** An attacker with the private key can generate installation tokens for any installation of the app and use those tokens to read repository contents and write Check Runs - within Layne's declared permissions. They cannot push code or access admin settings.
:::

**Response:**
1. Go to the GitHub App settings → **Private keys** → generate a new key, then delete the compromised one. Tokens signed with the revoked key stop working immediately.
2. Update `GITHUB_APP_PRIVATE_KEY` in your `.env` and secrets store.
3. Redeploy both containers.

### Anthropic API key leaked

:::danger
**Impact:** An attacker can make Anthropic API calls billed to your account.
:::

**Response:** Rotate the key in the Anthropic console and update `ANTHROPIC_API_KEY` in your `.env` and secrets store.


## Scanner Isolation

Semgrep and Trufflehog run as subprocesses inside the worker container via `execFile` (not a shell). Arguments are passed as an array, so shell injection through file paths or config values is not possible.

The worker container has no outbound network restrictions by default. Semgrep's `--config auto` fetches rules from the internet; Trufflehog's `--no-update` flag prevents version checks but does not restrict its scanning behaviour. If your threat model requires network isolation, configure Docker network policies accordingly.


## Finding Suppression

Semgrep's built-in `// nosemgrep` mechanism is disabled via `--disable-nosem` on every scan. This prevents contributors from self-approving a finding inline - adding `// nosemgrep` in a PR would suppress the finding in that exact PR, bypassing the security review gate.

The replacement is the `// SECURITY: <reason>` comment. It is tamper-proof: the suppressor (`src/suppressor.js`) reads each file at the **merge-base SHA** of the PR via `git show` and checks whether the comment existed there. A `// SECURITY:` comment introduced in the current PR is not present at the merge base, so it has no effect. The comment must have been merged in a previous PR - reviewed and approved - before it suppresses anything.

The suppressor runs in the worker after `dispatch()` returns findings and before `buildAnnotations()` is called. A suppressed finding is removed from the list entirely and never appears in the GitHub Check Run.


## Reporting a Vulnerability in Layne

See [SECURITY.md](https://github.com/your-org/layne/blob/main/SECURITY.md).
