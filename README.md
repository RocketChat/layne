# Layne

<p align="center">
  <img src="assets/layne-logo.png" alt="Layne logo" width="160" />
</p>

> Layne is a self-hosted GitHub App that centralises security scanning across our repositories. Since we don't use commercial SAST/secrets scanning tools, nor we have access to GitHub Enterprise, it can get hard to maintain different GitHub Actions workflow files across different repositories - especially as such repositories grow in number. Instead, we install Layne once and it listens for pull request events, runs our security tools server-side, posts the results back as native GitHub Check Run annotations, and notifies our security team's security notifications channel.

This tool was based on [Reddit's Implementation](https://web.archive.org/web/20250801064657/https://www.reddit.com/r/RedditEng/comments/1hks4f3/how_we_are_self_hosting_code_scanning_at_reddit/).

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
- [Operations](#operations)
  - [Automated Deployment](#automated-deployment)
  - [Scaling Workers](#scaling-workers)
  - [Renewing TLS Certificates](#renewing-tls-certificates)
  - [Updating Tool Versions](#updating-tool-versions)
  - [Debugging](#debugging)
- [Further Documentation](#further-documentation)

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

## Deployment

### Prerequisites

You can deploy Layne anywhere you want. The way we deploy it requires:

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
   | Issues | Read & write (required for label management) |

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

4. Run the one-time TLS setup. This uses Certbot inside Docker to obtain a Let's Encrypt certificate — no host-level nginx install needed:

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

## Operations

### Automated Deployment

Layne ships with a GitHub Actions workflow (`.github/workflows/deploy.yml`) that runs tests and then deploys to your EC2 instance on every push to `main`. It can also be triggered manually from the Actions tab via `workflow_dispatch`.

**What the workflow does:**

1. Runs the full test suite — the deploy step is skipped if tests fail
2. Rsyncs the repository to `/home/ubuntu/layne/layne/` on the server, preserving `data/` (certbot certificates) and never touching `.env`
3. Writes a fresh `.env` file from GitHub secrets
4. Runs `docker compose up --build --no-deps -d server worker` — rebuilds and restarts only the server and worker, leaving Redis (and the BullMQ queue) untouched

**Required GitHub secrets:**

Go to your repository → **Settings → Secrets and variables → Actions** and add:

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
| `ROCKETCHAT_WEBHOOK_URL` | Global Rocket.Chat incoming webhook URL (required when `$global.notifications.rocketchat.webhookUrl` is `"$ROCKETCHAT_WEBHOOK_URL"`) |

**Optional GitHub Actions variables** (Settings → Secrets and variables → Actions → Variables):

| Variable | Default | Description |
|---|---|---|
| `METRICS_ENABLED` | `false` | Set to `true` to enable Prometheus metrics on the deployed instance |
| `METRICS_PORT` | `9091` | Port for the worker metrics HTTP server |

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

## Further Documentation

- [**Configuration**](docs/configuration.md) — per-repo scanner settings, PR labels, and chat notifications
- [**Metrics**](docs/metrics.md) — Prometheus metrics and the bundled Grafana dashboard
- [**Extending Layne**](docs/extending.md) — adding new scanners and notification providers
- [**Reference**](docs/reference.md) — environment variables, finding shape, severity levels, and queue behaviour
