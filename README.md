# Layne

<p align="center">
  <img src="assets/layne-logo.png" alt="Layne logo" width="160" />
</p>

> Layne is a self-hosted GitHub App that centralises security scanning across our repositories. Since we don't use commercial SAST/secrets scanning tools, nor we have access to GitHub Enterprise, it can get hard to maintain different GitHub Actions workflow files across different repositories - especially as such repositories grow in number. Instead, we install Layne once and it listens for pull request events, runs our security tools server-side, and posts the results back as native GitHub Check Run annotations.

This tool was based on [Reddit's Implementation](https://web.archive.org/web/20250801064657/https://www.reddit.com/r/RedditEng/comments/1hks4f3/how_we_are_self_hosting_code_scanning_at_reddit/).

---

## Table of Contents

- [How It Works](#how-it-works)
- [Per-Repo Configuration](#per-repo-configuration)
- [Notifications](#notifications)
- [Deployment](#deployment)
  - [Prerequisites](#prerequisites)
  - [Step 1 — Create the GitHub App](#step-1--create-the-github-app)
  - [Step 2 — Provision the EC2 Instance](#step-2--provision-the-ec2-instance)
  - [Step 3 — Install Docker](#step-3--install-docker)
  - [Step 4 — Deploy Layne](#step-4--deploy-layne)
  - [Step 5 — Verify](#step-5--verify)
- [Adding a New Tool](#adding-a-new-tool)
- [Operations](#operations)
  - [Automated Deployment](#automated-deployment)
  - [Scaling Workers](#scaling-workers)
  - [Renewing TLS Certificates](#renewing-tls-certificates)
  - [Updating Tool Versions](#updating-tool-versions)
  - [Debugging](#debugging)
- [Reference](#reference)
  - [Environment Variables](#environment-variables)

---

## How It Works

```
                        ┌─────────────────────────────────┐
                        │      GITHUB PULL REQUEST        │  ◀──────────────────────┐
                        │      (OPEN, SYNC, REOPEN)       │                         │
                        └─────────────────────────────────┘                         │
                                        │                                 Check run │
                                  HTTP Post /webhook                                │ 
                                        │                                           │
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  EC2 Instance (Docker)                │                                           │      │
│                               ┌───────▼────────┐                                  │      │
│                               │  NGINX + TLS   │                                  │      │
│                               └───────┬────────┘                                  │      │
│                                       │                                           │      │
│                 ┌─────────────────────┘                                           │      │
│                 │                                                                 │      │
│┌─────────────┐  │   Schedules job   ┌────────────────┐    ┌────────────┐          │      │
││    LAYNE    │◀─┘ ─────────────────▶│     REDIS      │───▶│ TRUFFLEHOG │──┐       │      │
││    SERVER   │                      │    (BULLMQ)    │ │  └────────────┘  │       │      │
│└─────────────┘                      └────────────────┘ │  ┌────────────┐  │  ┌──────────┐│
│                                                        │─▶│   SEMGREP  │──┼─▶│ REPORTER ││
│                                                        │  └────────────┘  │  └──────────┘│
│                                                        │  ┌────────────┐  │              │
│                                                        └─▶│   CLAUDE   │──┘              │
│                                                           └────────────┘                 │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

When a PR is opened or updated, GitHub sends a webhook to Layne. The server immediately enqueues a scan job and returns `200 OK` to GitHub. A worker picks up the job, clones exactly the commit that triggered the event, runs Trufflehog (secrets) and Semgrep (SAST) against only the files changed in the PR, and posts the results as inline annotations on the Check Run.

Scans are **diff-aware**: only the files modified in the PR are passed to each scanner. Findings in files you did not touch are never reported.

---

## Per-Repo Configuration

Scanner behaviour can be customised per repository without touching any code. All overrides live in `config/repos.json`, keyed by `"owner/repo"`. Layne reads this file once at worker startup; **restart the worker to pick up changes** (the automated deploy pipeline does this automatically).

Repositories with no entry — or whose entry omits a tool block — get the defaults:

| Tool | Default behaviour |
|---|---|
| Semgrep | `semgrep scan --config auto --json <files>` |
| Trufflehog | `trufflehog filesystem --json --no-update <files>` |
| Claude | disabled (must opt in per repo) |

### Schema

```json
{
  "owner/repo": {
    "semgrep": {
      "enabled": true,
      "extraArgs": ["--config", "p/ruleset", "--severity", "WARNING"]
    },
    "trufflehog": {
      "enabled": true,
      "extraArgs": ["--only-verified", "--exclude-detectors", "GitHub,Slack"]
    },
    "claude": {
      "enabled": true,
      "model": "claude-haiku-4-5-20251001"
    }
  }
}
```

**Semgrep / Trufflehog keys:**

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Set to `false` to skip the tool entirely for this repo |
| `extraArgs` | string[] | see below | CLI flags passed verbatim to the tool, between the subcommand and `--json` |

**Default `extraArgs`:**
- Semgrep: `["--config", "auto"]`
- Trufflehog: `[]`

> **Replacement, not extension.** When you set `extraArgs`, it fully replaces the default. If you want `--config auto` _and_ a custom ruleset, include both:
> ```json
> "extraArgs": ["--config", "auto", "--config", "p/owasp-top-ten"]
> ```

**Claude keys:**

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Must be set to `true` to enable Claude scanning for this repo |
| `model` | string | `claude-haiku-4-5-20251001` | Claude model ID to use for analysis |

> **Opt-in only.** Claude scanning is disabled by default to avoid unexpected API costs. Each repo must explicitly set `"enabled": true`. Requires `ANTHROPIC_API_KEY` to be set in the environment.

### Examples

**Use a specific Semgrep ruleset instead of `auto`:**
```json
{
  "acme/frontend": {
    "semgrep": {
      "extraArgs": ["--config", "p/owasp-top-ten", "--severity", "WARNING"]
    }
  }
}
```

**Run multiple Semgrep rulesets on a Python backend:**
```json
{
  "acme/backend": {
    "semgrep": {
      "extraArgs": ["--config", "p/security-audit", "--config", "p/python"]
    }
  }
}
```

**Only report verified secrets (reduce Trufflehog noise):**
```json
{
  "acme/scripts": {
    "trufflehog": {
      "extraArgs": ["--only-verified"]
    }
  }
}
```

**Disable a scanner entirely for a repo:**
```json
{
  "acme/internal-tool": {
    "trufflehog": {
      "enabled": false
    }
  }
}
```

**Combine overrides for both tools:**
```json
{
  "acme/monorepo": {
    "semgrep": {
      "extraArgs": ["--config", "p/owasp-top-ten", "--exclude", "tests/**"]
    },
    "trufflehog": {
      "extraArgs": ["--only-verified", "--exclude-detectors", "GitHub,Slack"]
    }
  }
}
```

**Enable Claude malicious-intent scanning for a repo:**
```json
{
  "acme/frontend": {
    "claude": { "enabled": true }
  }
}
```

**Use a more capable Claude model for a sensitive repo:**
```json
{
  "acme/payments": {
    "claude": {
      "enabled": true,
      "model": "claude-opus-4-6"
    }
  }
}
```

### How args are assembled

The final CLI invocations look like this (using the Semgrep example above):

```
semgrep scan <extraArgs> --json <absolute-file-paths...>
trufflehog filesystem --json --no-update <extraArgs> <absolute-file-paths...>
```

Arguments are passed directly via `execFile` — **not** through a shell — so no quoting or escaping is needed and shell injection is not possible.

---

## Notifications

Layne can send a notification to a chat webhook when a scan finds issues. Notifications fire after the GitHub Check Run is fully posted — engineers see the check result first, then receive the alert.

Notifications are **opt-in** and **modular**: each notifier (e.g. Rocket.Chat) is an independent module. Adding a new provider in the future (e.g. Slack) requires only adding a new notifier file and two lines in the orchestrator — no core scan logic changes.

### Global vs per-repo

You can define a **global** notification config that applies to all repositories, and/or a **per-repo** override for specific repositories. Both are optional — if neither is defined, no notifications are sent and nothing breaks.

**Resolution rules (per notifier key):**
- If a repo has no `notifications` block → it inherits the global config entirely.
- If a repo defines its own `notifications` block → its keys win over the global ones for matching notifiers.
- A repo can opt out of a specific global notifier by setting `"enabled": false` for that notifier.
- If both global and the repo define *different* notifier keys, both are active (e.g. global Slack + repo-specific Rocket.Chat).

### Schema

```json
{
  "$global": {
    "notifications": {
      "rocketchat": {
        "enabled":    true,
        "webhookUrl": "$ROCKETCHAT_WEBHOOK_URL"
      }
    }
  },
  "owner/repo": {
    "notifications": {
      "rocketchat": {
        "enabled":    true,
        "webhookUrl": "$REPO_ROCKETCHAT_WEBHOOK_URL",
        "template":   "optional custom message (see below)"
      }
    }
  }
}
```

### Rocket.Chat

Sends a POST request to a Rocket.Chat incoming webhook URL.

| Key | Type | Required | Description |
|---|---|---|---|
| `enabled` | boolean | yes | Must be `true` to activate this notifier |
| `webhookUrl` | string | yes | Webhook URL, or an env var reference like `"$ROCKETCHAT_WEBHOOK_URL"` |
| `template` | string | no | Custom message template (see below). Omit for the default grouped format |

**`webhookUrl` — keeping secrets out of `repos.json`:**

If the value starts with `$`, Layne treats the rest as an environment variable name and reads it at runtime. This way your webhook URL never needs to be committed to the repository.

```json
"webhookUrl": "$ROCKETCHAT_WEBHOOK_URL"
```

If the env var is not set, Layne logs a warning and skips the notification — the scan result is unaffected.

**Default message format:**

When no `template` is set, Layne sends a grouped message showing severity counts and all findings organised by tool:

```
:warning: *Security findings in acme/payments PR #42*
• 1 high, 1 medium

*semgrep*
  • src/app.js:10 [HIGH] semgrep/sql-injection — User input passed to raw query

*trufflehog*
  • .env:3 [HIGH] trufflehog/aws-key — AWS access key detected
```

**Custom template:**

Set `template` to a string with `{{variable}}` placeholders:

| Placeholder | Value |
|---|---|
| `{{repo}}` | Full repo slug, e.g. `acme/payments` |
| `{{owner}}` | Owner/org name, e.g. `acme` |
| `{{repoName}}` | Repo name only, e.g. `payments` |
| `{{prNumber}}` | Pull request number |
| `{{total}}` | Total finding count |
| `{{critical}}` | Count of critical findings |
| `{{high}}` | Count of high findings |
| `{{medium}}` | Count of medium findings |
| `{{low}}` | Count of low findings |
| `{{summary}}` | Pre-rendered summary line, e.g. `Found 2 issue(s): 1 high, 1 medium.` |

Example:
```json
"template": ":rotating_light: *{{repo}} PR #{{prNumber}}* — {{total}} finding(s): {{critical}} critical, {{high}} high"
```

Custom templates do not include the per-tool grouped listing. To get the grouped format, omit `template`.

### Examples

**Notify all repos via a single global webhook:**
```json
{
  "$global": {
    "notifications": {
      "rocketchat": {
        "enabled":    true,
        "webhookUrl": "$ROCKETCHAT_WEBHOOK_URL"
      }
    }
  }
}
```

**Per-repo webhook with a custom message for a sensitive repo:**
```json
{
  "$global": {
    "notifications": {
      "rocketchat": {
        "enabled":    true,
        "webhookUrl": "$ROCKETCHAT_WEBHOOK_URL"
      }
    }
  },
  "acme/payments": {
    "notifications": {
      "rocketchat": {
        "enabled":    true,
        "webhookUrl": "$PAYMENTS_ROCKETCHAT_WEBHOOK_URL",
        "template":   ":rotating_light: *Payment system alert — {{repo}} PR #{{prNumber}}*\n{{total}} finding(s): {{critical}} critical, {{high}} high, {{medium}} medium, {{low}} low"
      }
    }
  }
}
```

**Opt a specific repo out of global notifications:**
```json
{
  "$global": {
    "notifications": {
      "rocketchat": { "enabled": true, "webhookUrl": "$ROCKETCHAT_WEBHOOK_URL" }
    }
  },
  "acme/noisy-repo": {
    "notifications": {
      "rocketchat": { "enabled": false }
    }
  }
}
```

### Adding a new notifier

Adding a new chat provider (e.g. Slack) requires three steps and no changes to core scan logic:

1. Create `src/notifiers/slack.js` exporting `async function notify({ findings, owner, repo, prNumber, toolConfig })`. The function must never throw — catch all errors internally.
2. In `src/notifiers/index.js`, add the import and add `slack` to the `NOTIFIERS` object.
3. Create `src/__tests__/notifiers/slack.test.js`.

---

## Deployment

### Prerequisites

You can deploy it anyway and anywhere you want. The way we're deploying it, however, requires the following:

- An AWS account with EC2 access
- A domain name you control (for TLS)
- Docker and Docker Compose installed on the EC2 instance
- GitHub organisation admin access (to create and install the GitHub App)

Everything runs inside Docker Compose — nginx, Certbot, Redis, the server, and the worker. No manual nginx install on the host is required.

---

### Step 1 — Create the GitHub App

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.

2. Fill in the form:
   - **GitHub App name:** `Layne` (or any name you prefer)
   - **Homepage URL:** `https://your-domain.com`
   - **Webhook URL:** `https://your-domain.com/webhook`
   - **Webhook secret:** generate one with `openssl rand -hex 32` and save it — you will need it later.

3. Under **Repository permissions**, set:
   | Permission | Access |
   |---|---|
   | Checks | Read & write |
   | Contents | Read-only |
   | Pull requests | Read-only |

4. Under **Subscribe to events**, check **Pull request**.

5. Set **Where can this GitHub App be installed?** to **Only on this account** (or Any account if you plan to share it).

6. Click **Create GitHub App**. Note the **App ID** shown at the top of the page.

7. Scroll down to **Private keys** and click **Generate a private key**. A `.pem` file will be downloaded — keep it safe.

8. On the left sidebar, click **Install App** and install it on the repositories you want Layne to scan.

---

### Step 2 — Provision the EC2 Instance

1. Launch an EC2 instance. Recommended spec:
   - **Instance type:** `t3.medium` or larger (Semgrep is CPU-intensive)
   - **AMI:** Ubuntu 22.04 LTS or Amazon Linux 2023
   - **Storage:** 20 GB gp3 (scan workspaces are ephemeral but the Docker image is ~2 GB)

2. In the **Security Group**, open:
   - Port `443` (HTTPS) — inbound from `0.0.0.0/0`
   - Port `80` (HTTP) — inbound from `0.0.0.0/0` (needed for ACME challenges during cert issuance)
   - Port `22` (SSH) — inbound from your IP only

3. Assign an **Elastic IP** to the instance so the address is stable.

4. Point your domain's **A record** to the Elastic IP. Wait for DNS to propagate before continuing.

---

### Step 3 — Install Docker

SSH into the instance and run:

```bash
# Ubuntu 22.04
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER
newgrp docker
```

---

### Step 4 — Deploy Layne

1. Clone the repository onto the instance:

```bash
git clone https://github.com/your-org/layne.git
cd layne
```

2. Create your environment file:

```bash
cp .env.example .env
```

3. Edit `.env` and fill in your values:

```bash
# The numeric App ID from the GitHub App settings page
GITHUB_APP_ID=123456

# The private key from the downloaded .pem file — paste the full content
# on a single line, replacing literal newlines with \n
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAA...\n-----END RSA PRIVATE KEY-----"

# The webhook secret you generated in Step 1
GITHUB_WEBHOOK_SECRET=your-32-char-hex-secret

# Your domain and email for Let's Encrypt
DOMAIN=your-domain.com
LETSENCRYPT_EMAIL=you@example.com
```

To convert the private key to a single line:
```bash
awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' layne.pem
```

4. Run the one-time TLS setup. This uses Certbot inside Docker to obtain a
   Let's Encrypt certificate — no host-level nginx install needed:

```bash
chmod +x scripts/init-tls.sh
./scripts/init-tls.sh
```

The script creates a dummy self-signed cert, starts nginx, requests the real certificate from Let's Encrypt, then reloads nginx with the real cert.

5. Build and start all services:

```bash
docker compose up --build -d
```

6. Check that everything is running:

```bash
docker compose ps
docker compose logs -f
```

7. Verify the health endpoint:

```bash
curl https://your-domain.com/health
# → {"status":"ok"}
```

---

### Step 5 — Verify

Open a pull request on one of the repos where Layne is installed. Within a few seconds you should see a **Layne** check appear on the PR in `queued` status, then `in progress`, then `success` or `failure` with inline annotations if issues were found.

---

## Adding a New Tool

Each security tool is an **adapter** — a single file in `src/adapters/` that runs the tool and converts its output to Layne's common finding format. Adding a new tool takes three steps.

### 1. Write the adapter

Create `src/adapters/mytool.js`. The adapter exports one async function that receives a context object and returns an array of findings.

```js
// src/adapters/mytool.js
import { execFile } from 'child_process';

export async function runMytool({ workspacePath, changedFiles }) {
  // changedFiles is an array of paths relative to the repo root.
  // Pass workspacePath + '/' + file to get absolute paths on disk.

  const stdout = await exec('mytool', ['--json', workspacePath]);

  let results;
  try {
    results = JSON.parse(stdout);
  } catch {
    return [];
  }

  return results.map(r => toFinding(r, workspacePath));
}

function toFinding(result, workspacePath) {
  // Strip the workspacePath prefix so the path is relative to the repo root.
  // The GitHub Checks API requires repo-root-relative paths for annotations.
  const prefix = workspacePath + '/';
  const file = result.path?.startsWith(prefix)
    ? result.path.slice(prefix.length)
    : result.path ?? 'unknown';

  return {
    file,                          // repo-root-relative path  (required)
    line:     result.line ?? 1,    // line number              (required)
    severity: 'high',              // 'high' | 'medium' | 'low'
    message:  result.message,      // annotation body text
    ruleId:   `mytool/${result.id}`, // stable identifier for the rule
    tool:     'mytool',            // used in the check run summary
  };
}

// Resolve with stdout even on non-zero exit so findings are not lost.
// Many security tools exit non-zero when they find issues (e.g. Semgrep
// exits 1, Trufflehog exits 183). Only reject when there is no output at all.
function exec(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (err, stdout) => {
      if (err && !stdout) reject(err);
      else resolve(stdout ?? '');
    });
  });
}
```

**Finding fields:**

| Field | Type | Description |
|---|---|---|
| `file` | `string` | Path relative to the repo root (strip `workspacePath + '/'`) |
| `line` | `number` | Line number for the annotation (use `1` if unavailable) |
| `severity` | `'high' \| 'medium' \| 'low'` | Controls annotation styling in the GitHub UI |
| `message` | `string` | Body text of the inline annotation |
| `ruleId` | `string` | Stable identifier used to deduplicate or suppress findings |
| `tool` | `string` | Name shown in the check run summary |

### 2. Register the adapter in the dispatcher

Open `src/dispatcher.js` and add your adapter to the `Promise.all` call:

```js
import { runTrufflehog } from './adapters/trufflehog.js';
import { runSemgrep }    from './adapters/semgrep.js';
import { runMytool }     from './adapters/mytool.js';   // add this

export async function dispatch({ workspacePath, changedFiles, baseSha, baseRef, labels, owner, repo }) {
  const [trufflehogFindings, semgrepFindings, mytoolFindings] = await Promise.all([
    runTrufflehog({ workspacePath, changedFiles }),
    runSemgrep({ workspacePath, changedFiles }),
    runMytool({ workspacePath, changedFiles }),           // add this
  ]);

  return [...trufflehogFindings, ...semgrepFindings, ...mytoolFindings];
}
```

The `dispatch` function also receives `baseSha`, `baseRef`, `labels`, `owner`, and `repo` — pass any of these to your adapter if the tool needs them (for example, to use a custom ruleset based on repository labels).

### 3. Install the tool in the Dockerfile

Add an `ARG` for the version and a `RUN` step to install the binary in the `runtime` stage of the `Dockerfile`:

```dockerfile
ARG MYTOOL_VERSION=1.0.0

RUN curl -fsSL https://github.com/example/mytool/releases/download/v${MYTOOL_VERSION}/mytool-linux-amd64 \
      -o /usr/local/bin/mytool \
  && chmod +x /usr/local/bin/mytool
```

Pin the version so builds are reproducible. Pass `--build-arg MYTOOL_VERSION=x.y.z` to `docker compose build` to upgrade.

---

## Operations

### Automated Deployment

Layne ships with a GitHub Actions workflow (`.github/workflows/deploy.yml`) that runs tests and then deploys to your EC2 instance on every push to `main`. It can also be triggered manually from the Actions tab via `workflow_dispatch`.

**What the workflow does:**

1. Runs the full test suite — the deploy step is skipped if tests fail
2. Rsyncs the repository to `/home/ubuntu/layne/layne/` on the server, preserving `data/` (certbot certificates) and never touching `.env`
3. Writes a fresh `.env` file from GitHub secrets
4. Runs `docker compose up --build --no-deps -d server worker` — rebuilds and restarts only the server and worker, leaving Redis (and the BullMQ queue) untouched

**Required GitHub secrets:**

Go to your repository → **Settings → Secrets and variables → Actions** and add the following:

| Secret | Description |
|---|---|
| `EC2_HOST` | Public IP or hostname of the EC2 instance |
| `EC2_SSH_KEY` | Contents of the SSH private key (`.pem`) used to connect to the instance |
| `GH_APP_ID` | GitHub App ID (maps to `GITHUB_APP_ID` in `.env`) |
| `GH_APP_PRIVATE_KEY` | RSA private key, single line with `\n`-escaped newlines (maps to `GITHUB_APP_PRIVATE_KEY` in `.env`) |
| `GH_WEBHOOK_SECRET` | Webhook HMAC secret (maps to `GITHUB_WEBHOOK_SECRET` in `.env`) |
| `DOMAIN` | Domain name for TLS (e.g. `layne.example.com`) |
| `LETSENCRYPT_EMAIL` | Email for Let's Encrypt expiry notifications |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude scanning (required when any repo has `claude.enabled: true`) |
| `ROCKETCHAT_WEBHOOK_URL` | Global Rocket.Chat incoming webhook URL (required when `$global.notifications.rocketchat.webhookUrl` is set to `"$ROCKETCHAT_WEBHOOK_URL"`) |

> **Note:** GitHub reserves the `GITHUB_` prefix for its own built-in variables, so the three app secrets use a `GH_` prefix here. The workflow maps them to the correct `GITHUB_`-prefixed names when writing `.env`.

The workflow uses a GitHub [**environment**](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment) named `production`. You can configure deployment protection rules on that environment (e.g. require a manual approval before deploying to production).

---

### Scaling Workers

The worker runs with `concurrency: 3` by default (3 jobs per process). To handle more simultaneous PRs, run additional worker containers:

```bash
docker compose up --scale worker=3 -d
```

---

### Renewing TLS Certificates

Let's Encrypt certificates expire after 90 days. Renew with:

```bash
docker compose run --rm certbot renew
docker compose exec nginx nginx -s reload
```

Add this to a monthly cron job on the host to automate renewal.

---

### Updating Tool Versions

Trufflehog and Semgrep versions are pinned directly in the `Dockerfile`. To update them, edit the version strings in that file, then rebuild and restart:

```bash
docker compose build
docker compose up -d
```

Test the new versions in a staging environment before deploying to production.

---

### Debugging

Set `DEBUG_MODE=true` in your `.env` file (or as a Docker environment variable) to enable verbose logging across all Layne components. When active, you will see:

- Every git command executed during the clone and diff phases (with tokens redacted)
- The exact files passed to each scanner
- Trufflehog batch progress (useful for large PRs)
- Every GitHub API call (createCheckRun, startCheckRun, completeCheckRun) and annotation chunk counts
- Installation token generation events
- Webhook event details (action, repo, PR number, commit SHA)

Stderr from subprocesses (git, semgrep, trufflehog) is **always** logged when non-empty, regardless of `DEBUG_MODE`. This is intentional — stderr from these tools almost always indicates a misconfiguration or tool error worth knowing about.

To enable on a running stack without a full rebuild:

```bash
# Add to .env
DEBUG_MODE=true

# Restart only the affected containers
docker compose up --no-deps -d server worker

# Follow logs
docker compose logs -f worker
```

To disable, remove or set `DEBUG_MODE=false` and restart.

---

## Reference

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_APP_ID` | Yes | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | Yes | RSA private key (single line, `\n`-escaped) |
| `GITHUB_WEBHOOK_SECRET` | Yes | HMAC secret for webhook signature verification |
| `ANTHROPIC_API_KEY` | No | Anthropic API key for Claude scanning (required when any repo has `claude.enabled: true`) |
| `REDIS_URL` | Yes | Redis connection string (set automatically in Docker Compose) |
| `DOMAIN` | Yes | Domain name for TLS (e.g. `layne.example.com`) |
| `LETSENCRYPT_EMAIL` | Yes | Email for Let's Encrypt expiry notifications |
| `PORT` | No | Port for the webhook server (default: `3000`) |
| `DEBUG_MODE` | No | Set to `true` or `1` to enable verbose debug logging (default: off) |
| `ROCKETCHAT_WEBHOOK_URL` | No | Rocket.Chat incoming webhook URL, referenced as `"$ROCKETCHAT_WEBHOOK_URL"` in `config/repos.json`. Add additional env vars (e.g. `PAYMENTS_ROCKETCHAT_WEBHOOK_URL`) for per-repo webhooks. |
