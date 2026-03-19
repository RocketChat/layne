# Deployment

This guide covers deploying Layne to a production EC2 instance with Docker Compose, TLS via Let's Encrypt, and an automated CI/CD pipeline. You can adapt it to any host that can run Docker Compose.

## Prerequisites

You can deploy Layne anywhere you want. The way we deploy it requires:

- An AWS account with EC2 access
- A domain name you control (for TLS)
- Docker and Docker Compose installed on the EC2 instance
- GitHub organisation admin access (to create and install the GitHub App)

Everything runs inside Docker Compose - nginx, Certbot, Redis, the server, and the worker. No manual nginx install on the host is required.


## Step 1 - Create the GitHub App

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.

2. Fill in the form:
   - **GitHub App name:** `Layne` (or any name you prefer)
   - **Homepage URL:** `https://your-domain.com`
   - **Webhook URL:** `https://your-domain.com/webhook`
   - **Webhook secret:** generate one with `openssl rand -hex 32` and save it - you will need it later.

3. Under **Repository permissions**, set:
   | Permission | Access |
   |---|---|
   | Checks | Read & write |
   | Contents | Read-only |
   | Pull requests | Read-only |
   | Issues | Read & write (required for label management) |

4. Under **Subscribe to events**, check **Pull request**, **Workflow run**, and **Workflow job**.

5. Set **Where can this GitHub App be installed?** to **Only on this account** (or Any account if you plan to share it).

6. Click **Create GitHub App**. Note the **App ID** shown at the top of the page.

7. Scroll down to **Private keys** and click **Generate a private key**. A `.pem` file will be downloaded - keep it safe.

8. On the left sidebar, click **Install App** and install it on the repositories you want Layne to scan.


## Step 2 - Provision the EC2 Instance

1. Launch an EC2 instance. Recommended spec:
   - **Instance type:** `t3.medium` or larger (Semgrep is CPU-intensive)
   - **AMI:** Ubuntu 22.04 LTS or Amazon Linux 2023
   - **Storage:** 20 GB gp3 (scan workspaces are ephemeral but the Docker image is ~2 GB)

2. In the **Security Group**, open:
   - Port `443` (HTTPS) - inbound from `0.0.0.0/0`
   - Port `80` (HTTP) - inbound from `0.0.0.0/0` (needed for ACME challenges during cert issuance)
   - Port `22` (SSH) - inbound from your IP only

3. Assign an **Elastic IP** to the instance so the address is stable.

4. Point your domain's **A record** to the Elastic IP. Wait for DNS to propagate before continuing.


## Step 3 - Install Docker

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


## Step 4 - Deploy Layne

1. Fork and clone the repository onto the instance:

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

# The private key from the downloaded .pem file - paste the full content
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

4. Run the one-time TLS setup. This uses Certbot inside Docker to obtain a Let's Encrypt certificate - no host-level nginx install needed:

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


## Step 5 - Verify

Open a pull request on one of the repos where Layne is installed. Within a few seconds you should see a **Layne** check appear on the PR in `queued` status, then `in progress`, then `success` or `failure` with inline annotations if issues were found.


## Operations

### Automated Deployment

Here is the GitHub Actions workflow we use internally to deploy Layne to an EC2 instance on every push to `develop`. Copy it into your own repository's `.github/workflows/deploy.yml` and configure the secrets below.

The workflow:

1. Runs the full test suite - the deploy step is skipped if tests fail
2. Rsyncs the repository to `/home/ubuntu/layne/layne/` on the server, preserving `data/` (certbot certificates) and never touching `.env`
3. Writes a fresh `.env` file from GitHub secrets
4. Runs `docker compose up --build --no-deps -d server worker` - rebuilds and restarts only the server and worker, leaving Redis (and the BullMQ queue) untouched

```yaml
name: Deploy

on:
  push:
    branches: [develop]
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run validate-config
      - run: npm test

  deploy:
    needs: test
    runs-on: ubuntu-latest
    environment: production

    steps:
      - uses: actions/checkout@v4

      - name: Set up SSH
        run: |
          mkdir -p ~/.ssh
          echo "${{ secrets.EC2_SSH_KEY }}" | tr -d '\r' > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          echo "Host deploy-target"                       >> ~/.ssh/config
          echo "  HostName ${{ secrets.EC2_HOST }}"       >> ~/.ssh/config
          echo "  User ubuntu"                            >> ~/.ssh/config
          echo "  IdentityFile ~/.ssh/deploy_key"         >> ~/.ssh/config
          echo "  StrictHostKeyChecking no"               >> ~/.ssh/config
          echo "  UserKnownHostsFile /dev/null"           >> ~/.ssh/config

      - name: Sync code to server
        run: |
          rsync -az --delete \
            --exclude='.git' \
            --exclude='node_modules' \
            --exclude='.env' \
            --exclude='data' \
            --exclude='coverage' \
            -e "ssh -F $HOME/.ssh/config" \
            ./ deploy-target:/home/ubuntu/layne/layne/

      - name: Write .env from secrets
        env:
          GH_APP_ID: ${{ secrets.GH_APP_ID }}
          GH_APP_PRIVATE_KEY: ${{ secrets.GH_APP_PRIVATE_KEY }}
          GH_WEBHOOK_SECRET: ${{ secrets.GH_WEBHOOK_SECRET }}
          DOMAIN: ${{ secrets.DOMAIN }}
          LETSENCRYPT_EMAIL: ${{ secrets.LETSENCRYPT_EMAIL }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          ROCKETCHAT_WEBHOOK_URL: ${{ secrets.ROCKETCHAT_WEBHOOK_URL }}
          METRICS_ENABLED: ${{ vars.METRICS_ENABLED }}
          METRICS_PORT: ${{ vars.METRICS_PORT }}
        run: |
          {
            printf 'GITHUB_APP_ID=%s\n'             "$GH_APP_ID"
            printf 'GITHUB_APP_PRIVATE_KEY=%s\n'    "$GH_APP_PRIVATE_KEY"
            printf 'GITHUB_WEBHOOK_SECRET=%s\n'     "$GH_WEBHOOK_SECRET"
            printf 'DOMAIN=%s\n'                    "$DOMAIN"
            printf 'LETSENCRYPT_EMAIL=%s\n'         "$LETSENCRYPT_EMAIL"
            printf 'ANTHROPIC_API_KEY=%s\n'         "$ANTHROPIC_API_KEY"
            printf 'ROCKETCHAT_WEBHOOK_URL=%s\n'    "$ROCKETCHAT_WEBHOOK_URL"
            printf 'METRICS_ENABLED=%s\n'           "${METRICS_ENABLED:-false}"
            printf 'METRICS_PORT=%s\n'              "${METRICS_PORT:-9091}"
          } | ssh -F "$HOME/.ssh/config" deploy-target \
              'cat > /home/ubuntu/layne/layne/.env'

      - name: Rebuild and restart server and worker
        run: |
          ssh -F "$HOME/.ssh/config" deploy-target \
            'cd /home/ubuntu/layne/layne &&
             docker compose up --build --no-deps -d server worker &&
             docker compose exec nginx nginx -s reload'
```

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

GitHub reserves the `GITHUB_` prefix for its own built-in variables, so the three app secrets use a `GH_` prefix here. The workflow maps them to the correct `GITHUB_`-prefixed names when writing `.env`.

The workflow uses a GitHub [**environment**](https://docs.github.com/en/actions/deployment/targeting-different-deployment-environments) named `production`. You can configure deployment protection rules on that environment (e.g. require a manual approval before deploying to production).


### Scaling Workers

The worker runs with `concurrency: 5` by default (5 jobs per process). To handle more simultaneous PRs, run additional worker containers:

```bash
docker compose up --scale worker=3 -d
```


### Renewing TLS Certificates

Let's Encrypt certificates expire after 90 days. Renew with:

```bash
docker compose run --rm certbot renew
docker compose exec nginx nginx -s reload
```

Add this to a monthly cron job on the host to automate renewal.


### Updating Tool Versions

Trufflehog and Semgrep versions are pinned directly in the `Dockerfile`. To update them, edit the version strings in that file, then rebuild and restart:

```bash
docker compose build
docker compose up -d
```

Test the new versions in a staging environment before deploying to production.


### Debugging

Set `DEBUG_MODE=true` in your `.env` file (or as a Docker environment variable) to enable verbose logging across all Layne components. When active, you will see:

- Every git command executed during the clone and diff phases (with tokens redacted)
- The exact files passed to each scanner
- Trufflehog batch progress (useful for large PRs)
- Every GitHub API call (createCheckRun, startCheckRun, completeCheckRun) and annotation chunk counts
- Installation token generation events
- Webhook event details (action, repo, PR number, commit SHA)

Stderr from subprocesses (git, semgrep, trufflehog) is always logged when non-empty, regardless of `DEBUG_MODE`. This is intentional - stderr from these tools almost always indicates a misconfiguration or tool error worth knowing about.

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
