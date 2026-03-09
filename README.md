# Layne

<p align="center">
  <img src="assets/layne-logo.png" alt="Layne logo" width="160" />
</p>

> Layne is a self-hosted GitHub App that centralises security scanning across our repositories. Since we don't use commercial SAST/secrets scanning tools, nor we have access to GitHub Enterprise, it can get hard to maintain different GitHub Actions workflow files across different repositories - especially as such repositories grow in number. Instead, we install Layne once and it listens for pull request events, runs our security tools server-side, and posts the results back as native GitHub Check Run annotations.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Deployment](#deployment)
  - [Prerequisites](#prerequisites)
  - [Step 1 — Create the GitHub App](#step-1--create-the-github-app)
  - [Step 2 — Provision the EC2 Instance](#step-2--provision-the-ec2-instance)
  - [Step 3 — Install Docker](#step-3--install-docker)
  - [Step 4 — Deploy Layne](#step-4--deploy-layne)
  - [Step 5 — Verify](#step-5--verify)
- [Adding a New Tool](#adding-a-new-tool)
- [Operations](#operations)
  - [Scaling Workers](#scaling-workers)
  - [Renewing TLS Certificates](#renewing-tls-certificates)
  - [Updating Tool Versions](#updating-tool-versions)
- [Reference](#reference)
  - [Environment Variables](#environment-variables)

---

## How It Works

```
  GitHub (pull_request event)
         │
         │ HTTPS POST /webhook
         ▼
  ┌──────────────────────────────────────────────────────────┐
  │  EC2 Instance (Docker Compose)                           │
  │                                                          │
  │  ┌─────────┐     ┌────────────────┐     ┌────────────┐   │
  │  │  nginx  │────▶│  Layne Server  │────▶│   Redis    │   │
  │  │  + TLS  │     │  :3000         │     │  (BullMQ)  │   │
  │  └─────────┘     └────────────────┘     └─────┬──────┘   │
  │  ┌─────────┐                                  │          │
  │  │ Certbot │                                  ▼          │
  │  └─────────┘                     ┌────────────────────┐  │
  │                                  │   Layne Worker     │  │
  │                                  │                    │  │
  │                                  │  git clone (SHA)   │  │
  │                                  │  trufflehog        │  │
  │                                  │  semgrep           │  │
  │                                  └────────┬───────────┘  │
  └───────────────────────────────────────────┼──────────────┘
                                              │
                                              │ Check Run annotations
                                              ▼
                                       GitHub Checks API
```

When a PR is opened or updated, GitHub sends a webhook to Layne. The server immediately enqueues a scan job and returns `200 OK` to GitHub. A worker picks up the job, clones exactly the commit that triggered the event, runs Trufflehog (secrets) and Semgrep (SAST) against only the files changed in the PR, and posts the results as inline annotations on the Check Run.

Scans are **diff-aware**: only the files modified in the PR are scanned, and Semgrep's `--baseline-commit` flag ensures it only reports findings introduced by the PR, not pre-existing ones on the base branch.

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
function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout) => {
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
    runSemgrep({ workspacePath, baseline: 'FETCH_HEAD' }),
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

Trufflehog and Semgrep versions are pinned in the `Dockerfile` as build arguments. To update:

```bash
docker compose build \
  --build-arg TRUFFLEHOG_VERSION=3.89.0 \
  --build-arg SEMGREP_VERSION=1.91.0
docker compose up -d
```

Test the new versions in a staging environment before deploying to production.

---

## Reference

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_APP_ID` | Yes | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | Yes | RSA private key (single line, `\n`-escaped) |
| `GITHUB_WEBHOOK_SECRET` | Yes | HMAC secret for webhook signature verification |
| `REDIS_URL` | Yes | Redis connection string (set automatically in Docker Compose) |
| `DOMAIN` | Yes | Domain name for TLS (e.g. `layne.example.com`) |
| `LETSENCRYPT_EMAIL` | Yes | Email for Let's Encrypt expiry notifications |
| `PORT` | No | Port for the webhook server (default: `3000`) |
