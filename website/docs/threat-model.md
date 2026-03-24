# Threat Model

This document covers Layne's own security posture - not the vulnerabilities it finds in user code. It maps what could go wrong, what the blast radius looks like, and what controls are in place.

## Assets

What this threat model is protecting:

- **GitHub credentials** - the App private key and webhook secret. Compromise gives an attacker varying degrees of access to repositories where Layne is installed.
- **Source code in transit** - changed files are cloned into an ephemeral workspace and, when the Claude scanner is enabled, sent to the Anthropic API.
- **Scan integrity** - Layne's Check Run is a security gate. Tampering with findings or suppression logic undermines the review process.
- **The deployment itself** - the host, containers, and Redis instance.


## Trust Boundaries

| Boundary | Direction | Trust level |
|---|---|---|
| GitHub → Layne webhook receiver | Inbound, public internet | Untrusted - verified by HMAC-SHA256 on every request |
| Layne → GitHub API | Outbound | Authenticated with short-lived installation tokens (1-hour TTL) |
| Layne → Anthropic API | Outbound | Authenticated with API key; source code leaves your environment |
| Layne → Redis | Internal network | Unauthenticated by default - trust depends on network isolation |
| Worker → Semgrep / Trufflehog | Subprocess, same container | Controlled - args passed as array via `execFile`, not a shell |

### GitHub App permissions

Layne requests the minimum permissions needed to do its job:

| Permission | Level | Why |
|---|---|---|
| Checks | Read & write | Creates and updates Check Runs with scan results and annotations |
| Contents | Read-only | Clones the PR head and base commits to scan changed files |
| Pull requests | Read-only | Queries PR metadata via the GitHub API |
| Issues | Read & write | Adds and removes labels; posts exception approval comments |
| Organization members | Read-only | Resolves team membership when `exceptionApprovers.teams` is configured |

Layne cannot push commits, modify repository contents, or change repository settings.


## Threats and Mitigations

### Forged webhooks

**Threat:** An attacker sends a crafted webhook payload to trigger scans on arbitrary refs, waste compute, or create spurious Check Runs.

**Mitigation:** Every inbound webhook is verified against an HMAC-SHA256 signature derived from `GITHUB_WEBHOOK_SECRET` before any processing occurs. Requests that fail verification are rejected with `401`. No job is enqueued and no GitHub API call is made.

**Additional hardening:** Restrict `/webhook` to GitHub's published source IP ranges at the Nginx layer. See [Hardening](#hardening).

**Residual risk:** The `geo` block is static - new GitHub IP ranges require a manual update and Nginx reload. A webhook flood from a valid GitHub IP still reaches Node.js (rate limiting is not built in).

---

### Finding suppression tampering

**Threat:** A contributor adds `// nosemgrep` to an offending line in their own PR, suppressing the finding in the exact review that should catch it.

**Mitigation:** `--disable-nosem` is passed on every Semgrep invocation. `// nosemgrep` annotations are ignored entirely.

The replacement suppression mechanism - `// SECURITY: <reason>` - is tamper-proof: `src/suppressor.js` reads the file at the **merge-base SHA** via `git show` and checks whether the comment existed there before the PR. A comment introduced in the current PR has no effect. It must have been merged and reviewed in a prior PR before it suppresses anything.

**Residual risk:** None for the nosemgrep vector. The `// SECURITY:` mechanism relies on reviewers catching abuse when the suppression comment is originally introduced.

---

### Scan result injection via subprocess

**Threat:** A malicious file path or config value is used to inject shell commands into scanner invocations.

**Mitigation:** Semgrep and Trufflehog are invoked via `execFile` with arguments passed as an array - not through a shell. Shell metacharacters in file paths or `extraArgs` values have no effect.

**Residual risk:** The worker container has no outbound network restrictions by default. Semgrep's `--config auto` fetches rules from the internet. If your threat model requires network isolation, configure Docker network policies accordingly.

---

### Source code exfiltration via Anthropic

:::warning
When the Claude scanner is enabled, **the full content of every changed source file** is sent to the Anthropic API. Source code leaves your environment. Skill mode is explicitly not ZDR (Zero Data Retention) eligible.
:::

**Threat:** Sensitive business logic, PII, or regulated data present in changed files is transmitted to a third-party API.

**Mitigation:** Claude is disabled by default and must be opted in per repo. Files are capped at 50 KB each. Binary files are skipped. Using `diff_only` scan mode reduces the surface to changed hunks plus context lines only - unchanged portions of files are not sent. A scoped custom `prompt` can further narrow the analysis.

**Residual risk:** Even in `diff_only` mode, changed lines containing sensitive data are transmitted. Evaluate whether enabling Claude is appropriate for repos with regulated data.

---

### Credential theft

**Threat:** The GitHub App private key, webhook secret, or Anthropic API key is leaked from the environment.

**Mitigations:**
- The private key is used only to sign short-lived JWTs, which are exchanged for installation tokens that expire after 1 hour. The key itself is never written to disk or logged.
- Installation tokens are generated fresh per scan job and scoped to the repositories where Layne is installed.
- The webhook secret and API keys live only in the process environment - never in Redis or logs.
- Notification webhook URLs can be stored as `"$ENV_VAR_NAME"` references in `config/layne.json` to keep them out of the repository.

**Residual risk:** If the host or container is compromised, all credentials in the environment are exposed. See [Credential Compromise Response](#credential-compromise-response) for rotation procedures.

---

### Unauthenticated metrics exposure

**Threat:** The Prometheus metrics endpoint is exposed publicly, leaking internal queue depths, scan counts, and timing data.

**Mitigation:** The metrics server runs on port `9091` and should never be exposed outside the internal network. Bind it to a private interface or restrict it at the firewall/security group level.

**Residual risk:** There is no authentication on the metrics endpoint itself - access control must be enforced at the network layer.


## Hardening

### Network exposure

| Port | Inbound | Notes |
|---|---|---|
| 443 (HTTPS) | From anywhere | Receives GitHub webhooks; restrict `/webhook` to GitHub IPs via Nginx |
| 80 (HTTP) | From anywhere | ACME certificate challenges only; redirect all other traffic to HTTPS |
| 22 (SSH) | Your IP only | Restrict at the security group level |
| 9091 (metrics) | Internal only | No authentication - never expose publicly |

### Nginx IP allowlisting

GitHub publishes its webhook source ranges at `https://api.github.com/meta` (the `.hooks` key).

```nginx
# GitHub webhook source IPs — https://api.github.com/meta (.hooks)
# Refresh these if GitHub rotates their ranges.
geo $is_github {
    default             0;
    192.30.252.0/22     1;
    185.199.108.0/22    1;
    140.82.112.0/20     1;
    143.55.64.0/20      1;
    2a0a:a440::/29      1;
    2606:50c0::/32      1;
}
```

Then restrict `/webhook` using the variable:

```nginx
location /webhook {
    if ($is_github = 0) {
        return 403;
    }
    proxy_pass         http://server:3000;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 30s;
}
```

:::tip
The `geo` block is static - it does not refresh automatically. If GitHub rotates their ranges, update the block and reload Nginx. Monitor `https://api.github.com/meta` or set up a periodic check.
:::


## Credential Compromise Response

### Webhook secret leaked

:::danger
**Impact:** An attacker can forge webhook payloads, causing Layne to scan arbitrary refs or create spurious Check Runs. Compute is wasted and notifications may fire. The attacker cannot read repository contents or modify code.
:::

1. Go to the GitHub App settings → **Webhook secret** → regenerate.
2. Update `GITHUB_WEBHOOK_SECRET` in your `.env` and secrets store.
3. Redeploy the server container.

### GitHub App private key leaked

:::danger
**Impact:** An attacker with the private key can generate installation tokens and use them to read repository contents and write Check Runs - within Layne's declared permissions. They cannot push code or access admin settings.
:::

1. Go to the GitHub App settings → **Private keys** → generate a new key, then delete the compromised one. Tokens signed with the revoked key stop working immediately.
2. Update `GITHUB_APP_PRIVATE_KEY` in your `.env` and secrets store.
3. Redeploy both containers.

### Anthropic API key leaked

:::danger
**Impact:** An attacker can make Anthropic API calls billed to your account.
:::

Rotate the key in the Anthropic console and update `ANTHROPIC_API_KEY` in your `.env` and secrets store.


## Data Retention

| Data | Where stored | Retention |
|---|---|---|
| Scan job queue | Redis | Until job completes or fails; evicted by BullMQ |
| Notification dedup counts | Redis (`layne:scan:count:…`) | 30-day TTL |
| Exception approval records | Redis (`layne:exception:…`, `layne:exception-ids:…`) | 30-day TTL; invalidated when the flagged line changes |
| PR metadata cache (deferred triggers) | Redis (`layne:pr:…`) | 7-day TTL |
| Cloned repository workspaces | Ephemeral temp directory | Deleted in `finally` block after each scan |
| Scan findings | Not stored | Posted directly to the GitHub Check Run and discarded |

Layne does not maintain a database of findings. If Redis is lost, the only consequence is that notifications may re-fire for previously notified PRs.


## Reporting a Vulnerability in Layne

See [SECURITY.md](https://github.com/your-org/layne/blob/main/SECURITY.md).
