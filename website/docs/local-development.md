# Local Development

This guide explains how to run Layne entirely on your own machine so you can develop and test features without touching production. By the end, you will have a real GitHub App delivering live webhooks to your laptop, and a way to replay those webhooks instantly without opening a real pull request every time.

## Prerequisites

Install the following before you start:

| Tool | Minimum version | How to check |
|---|---|---|
| Node.js | 22 | `node --version` |
| npm | 10 | `npm --version` |
| Docker | any recent version | `docker --version` |
| Docker Compose plugin | v2 | `docker compose version` |
| git | any recent version | `git --version` |
| openssl | any | `openssl version` |

You also need a **GitHub account** with permission to create a GitHub App (a personal account is fine).

On macOS, install Node.js and openssl via [Homebrew](https://brew.sh): `brew install node openssl`. Docker Desktop bundles the Compose plugin automatically.


## Step 1 - Create a dev GitHub App

You need a GitHub App to receive webhooks and post Check Runs. Create a **separate app just for development** - never reuse the production app - so your experiments do not affect real repositories.

### 1.1 Open the new-app form

- **Personal account:** go to https://github.com/settings/apps/new
- **Organisation:** go to `https://github.com/organizations/YOUR_ORG/settings/apps/new`

### 1.2 Fill in the basic fields

| Field | What to enter |
|---|---|
| **GitHub App name** | `Layne Dev` (any name - just avoid reusing the production name) |
| **Homepage URL** | `http://localhost:3000` (required by GitHub, not actually used in dev) |
| **Webhook URL** | Leave blank for now - you will fill this in during [Step 5](#step-5--receive-live-webhooks-via-smeeio) |
| **Webhook secret** | Run `openssl rand -hex 32` in your terminal, paste the output here, and **save it** - you will need it in your `.env` |

### 1.3 Set repository permissions

Scroll to **Repository permissions** and set exactly these:

| Permission | Access |
|---|---|
| Checks | Read & write |
| Contents | Read-only |
| Pull requests | Read-only |
| Issues | Read & write |

### 1.4 Subscribe to events

Under **Subscribe to events**, check **Pull request**, **Workflow run**, **Workflow job**, and **Issue comment**.

> If you only need to test the default `pull_request` trigger, checking just **Pull request** is sufficient. Add **Workflow run** and **Workflow job** if you want to test deferred trigger modes locally. **Issue comment** is required to test exception approvals.

### 1.5 Limit the installation scope

Set **Where can this GitHub App be installed?** to **Only on this account**. This prevents anyone else from accidentally installing your dev app.

### 1.6 Create the app and note the App ID

Click **Create GitHub App**. On the next page, note the **App ID** at the top - you will need it in your `.env`.

### 1.7 Generate a private key

Scroll down to the **Private keys** section and click **Generate a private key**. A `.pem` file will download to your computer.

Convert it to the single-line format that Layne expects:

```bash title="Terminal"
awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' ~/Downloads/layne-dev.*.private-key.pem
```

Copy the entire output (it starts with `-----BEGIN RSA PRIVATE KEY-----\n` and ends with `-----END RSA PRIVATE KEY-----\n`). You will paste it into `.env` in the next step.


## Step 2 - Install the App on a test repository

You need a repository to scan. Create a throwaway repo or use an existing personal repo - **do not install the dev app on production repositories**.

1. From the GitHub App settings page, click **Install App** in the left sidebar.
2. Select your account.
3. Choose **Only select repositories** and pick your test repo.
4. Click **Install**.

After installation, look at the URL of the page you land on:

```
https://github.com/settings/installations/NNNNNNNN
```

**Installation ID:** The number in the URL (`NNNNNNNN`) is your installation ID. You will need it to update the fixture files later.


## Step 3 - Set up the project locally

### 3.1 Clone the repository

```bash title="Terminal"
git clone https://github.com/your-org/layne.git
cd layne
npm install
```

### 3.2 Create your `.env` file

```bash
cp .env.example .env
```

Open `.env` in your editor and fill in the three required fields:

```bash title=".env"
# The numeric App ID from Step 1.6
GITHUB_APP_ID=123456

# The single-line private key output from Step 1.7
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAA...\n-----END RSA PRIVATE KEY-----\n"

# The webhook secret you generated in Step 1.2
GITHUB_WEBHOOK_SECRET=abc123def456...
```

Everything else in `.env.example` is commented out with sensible defaults - you do not need to change anything else to get started.

### 3.3 Add your test repo to the scanner config

Open `config/layne.json`. Add an entry for your test repository:

```json title="config/layne.json"
{
  "your-org/your-repo": {}
}
```

An empty object uses the global defaults: Semgrep and Trufflehog enabled, Claude disabled, plus any global notifications and labels defined in `config/layne.json`. In the checked-in example config, Rocket.Chat notifications are enabled globally, but local development still works fine if you leave the webhook env vars unset because the notifier will log and skip delivery.

Both the server and worker read `config/layne.json` once at startup. Restart both after any changes.


## Step 4 - Start the local stack

You need three things running: Redis, the webhook server, and the worker. Open three terminal windows.

**Terminal 1 - Redis:**

```bash
npm run dev:redis
```

This starts a Redis container in the background. Verify it is healthy:

```bash
docker compose -f docker-compose.dev.yml ps
```

You should see `redis` with status `running (healthy)`.

**Terminal 2 - Webhook server:**

```bash
npm start
```

Expected output:

```
[server] Layne listening on port 3000
```

Verify it is up:

```bash
curl http://localhost:3000/health
# → {"status":"ok"}
```

**Terminal 3 - Worker:**

```bash
npm run worker
```

Expected output:

```
[worker] Layne worker started - concurrency: 5
```

Semgrep and Trufflehog are only installed inside the Docker image. When running the worker directly on your machine, the worker will fail to run them unless you install them locally. See [Installing scanners locally](#installing-scanners-locally) below.


## Step 5 - Receive live webhooks via smee.io or ngrok

GitHub cannot deliver webhooks to `localhost` because it is not reachable from the internet. You need a public URL that forwards requests to your local server.

- **Use `smee.io`** if you want the simplest setup with minimal account/config overhead.
- **Use `ngrok`** if you want a direct public URL plus request inspection and replay tools while debugging.

GitHub's GitHub App docs still recommend `smee` for local webhook development, and mention `ngrok` as an alternative.

### 5.1 Option A - Use smee.io

Go to https://smee.io and click **Start a new channel**. You will get a unique URL like `https://smee.io/abc123xyz`. Keep this tab open.

### 5.2 Start the smee client

```bash
# One-time global install
npm install --global smee-client

# Forward events to your local server
smee --url https://smee.io/abc123xyz --target http://localhost:3000/webhook
```

Leave this terminal running. Every time a webhook arrives at smee.io, the client will forward it to your local server.

### 5.3 Point the GitHub App at your smee URL

1. Go back to your dev GitHub App settings page.
2. In the **Webhook URL** field, paste your smee URL (e.g. `https://smee.io/abc123xyz`).
3. Click **Save changes**.

### 5.4 Option B - Use ngrok instead

If you prefer a direct tunnel with a request inspector, install and authenticate the ngrok agent, then expose your local server:

```bash
# Start an HTTP tunnel to your local Layne server
ngrok http 3000
```

ngrok will print a forwarding URL such as `https://abc123.ngrok-free.app`. Use:

```text
https://abc123.ngrok-free.app/webhook
```

as the GitHub App's **Webhook URL**.

Useful extras while debugging:

- Open `http://127.0.0.1:4040` to inspect delivered requests.
- You can replay a captured webhook from the ngrok UI without opening a new pull request.

### 5.5 Trigger a scan

Open a pull request on your test repository. Within a few seconds you should see:

- The forwarding tool printing an incoming event (`smee` or `ngrok`)
- The server terminal printing `[server] Enqueued scan for your-org/your-repo#1`
- The worker terminal printing `[worker] starting scan: your-org/your-repo#1`
- A **Layne Dev** check appearing on the PR on GitHub

smee may replay queued events when you reconnect. If you see a scan triggered twice for the same commit, that is normal. Layne's Redis deduplication will quietly drop the second one.


## Step 6 - Replay webhooks without GitHub

Opening a real pull request every time you want to test a change gets old fast. The replay script lets you re-send a saved webhook payload to your local server in one command - no PR needed.

### 6.1 Update the fixture files

The fixture files in `fixtures/webhooks/` use placeholder values. For **end-to-end testing** (where the worker actually calls the GitHub API), you need to replace a few fields with your real values.

Open `fixtures/webhooks/pr_opened.json` and update:

| Field | Replace with |
|---|---|
| `repository.full_name` | `"your-org/your-repo"` - your actual test repo |
| `repository.name` | `"your-repo"` |
| `repository.owner.login` | `"your-org"` |
| `repository.clone_url` | `"https://github.com/your-org/your-repo.git"` |
| `pull_request.head.repo.clone_url` | same clone URL |
| `installation.id` | your installation ID from [Step 2](#step-2--install-the-app-on-a-test-repository) |
| `pull_request.head.sha` | a real commit SHA from your test repo |
| `pull_request.base.sha` | a real base commit SHA from your test repo |

If you only want to verify that the server parses the webhook, creates a Check Run, and enqueues a job, you do not need real SHAs or a real installation ID. The server will return `200 Accepted` and enqueue the job regardless. The worker will then fail trying to authenticate, but that is fine.

### 6.2 Run the replay script

```bash
# Replay the default fixture (pr_opened.json) to localhost:3000
npm run replay

# Replay a different fixture
npm run replay fixtures/webhooks/pr_synchronize.json

# Replay to a different port
npm run replay fixtures/webhooks/pr_opened.json http://localhost:3001
```

Example output:

```
[replay] fixture  → /path/to/layne/fixtures/webhooks/pr_opened.json
[replay] target   → http://localhost:3000/webhook
[replay] response → 200 Accepted
```

You will immediately see the server and worker pick up the job in their respective terminals.


## Step 7 - Read logs and debug

### Normal log output

Both processes prefix every line with their name:

```
[server] Webhook received: pull_request opened org/repo#1
[server] Enqueued scan for org/repo#1 (job: org/repo#1@abc123)
[worker] starting scan: org/repo#1 (sha: abc123)
[worker] scan complete: org/repo#1 - 3 findings
```

### Enable verbose debug logging

Set `DEBUG_MODE=true` in your `.env`, then restart both processes (`Ctrl-C` in each terminal and re-run). Debug mode adds:

- Every git command executed during clone and diff phases (with tokens redacted)
- The exact list of files passed to each scanner
- Trufflehog batch progress
- GitHub API call details (createCheckRun, annotation chunk counts)
- Webhook event details

### Inspect Redis directly

```bash
# Open a Redis CLI session in the running container
docker compose -f docker-compose.dev.yml exec redis redis-cli

# List all Layne keys
KEYS layne:*

# Check the scan count stored for a PR (used for notification deduplication)
GET "layne:scan:count:your-org/your-repo#1"

# List BullMQ jobs in the scans queue
LRANGE bull:scans:wait 0 -1
LRANGE bull:scans:active 0 -1
```


## Installing scanners locally

The `Dockerfile` installs Semgrep and Trufflehog at specific pinned versions. When you run `npm run worker` directly on your machine (outside Docker), the worker will try to shell out to those binaries and fail if they are not on your `PATH`.

Check the versions currently in use:

```bash
grep -E 'semgrep|trufflehog' Dockerfile
```

**Install Semgrep:**

```bash
pip install semgrep==1.154.0
# Verify:
semgrep --version
```

Requires Python 3.9+. On macOS, use `pip3` if `pip` points to Python 2.

**Install Trufflehog:**

```bash
# macOS (Apple Silicon)
curl -sL "https://github.com/trufflesecurity/trufflehog/releases/download/v3.93.7/trufflehog_3.93.7_darwin_arm64.tar.gz" \
  | tar -xz -C /usr/local/bin trufflehog
chmod +x /usr/local/bin/trufflehog

# macOS (Intel)
curl -sL "https://github.com/trufflesecurity/trufflehog/releases/download/v3.93.7/trufflehog_3.93.7_darwin_amd64.tar.gz" \
  | tar -xz -C /usr/local/bin trufflehog
chmod +x /usr/local/bin/trufflehog

# Linux (amd64)
curl -sL "https://github.com/trufflesecurity/trufflehog/releases/download/v3.93.7/trufflehog_3.93.7_linux_amd64.tar.gz" \
  | tar -xz -C /usr/local/bin trufflehog
chmod +x /usr/local/bin/trufflehog

# Verify:
trufflehog --version
```

**Alternative - run the worker inside Docker:**

If you prefer not to install the binaries locally, you can run the worker container against your local Redis instead. This requires building the Docker image first:

```bash
docker compose build worker
docker compose run --rm \
  --env-file .env \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  worker node src/worker.js
```

On macOS with Docker Desktop, `host.docker.internal` resolves to your host automatically. On Linux, add a host-gateway mapping:

```bash
docker compose run --rm \
  --add-host host.docker.internal:host-gateway \
  --env-file .env \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  worker node src/worker.js
```


## Stopping everything

```bash
# Stop the server and worker: Ctrl-C in their terminals

# Stop and remove the Redis container
npm run dev:stop
```


## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Server exits immediately with `Missing required environment variables` | `.env` not copied or required fields left empty | `cp .env.example .env` and fill in `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` |
| `[server] Webhook rejected: invalid signature` | `GITHUB_WEBHOOK_SECRET` in `.env` does not match the secret set in the GitHub App | Copy the secret from the GitHub App settings page and paste it into `.env` |
| `connect ECONNREFUSED 127.0.0.1:6379` | Redis is not running | `npm run dev:redis` |
| Worker logs `getInstallationToken failed` or GitHub API returns 404 | `installation.id` in the fixture is wrong, or the App is not installed on that repo | Use your real installation ID from `https://github.com/settings/installations` |
| `semgrep: command not found` | Semgrep is not installed on the host | See [Installing scanners locally](#installing-scanners-locally) |
| `trufflehog: command not found` | Trufflehog is not installed on the host | See [Installing scanners locally](#installing-scanners-locally) |
| smee delivers duplicate webhooks on reconnect | GitHub queued the event while smee was disconnected | Normal behavior - Layne's Redis deduplication drops the duplicate |
| `[replay] Error: could not reach the server` | Server is not running | `npm start` in another terminal |
| `[replay] response → 401 Invalid signature` | `GITHUB_WEBHOOK_SECRET` in `.env` does not match what the server expects | They must be identical - both processes load the same `.env` |
| Check Run never appears on GitHub | The worker failed to authenticate | Check worker logs for `getInstallationToken` errors; verify `GITHUB_APP_PRIVATE_KEY` is a valid single-line PEM |
| Config changes not picked up | Server and worker each cache `config/layne.json` at startup | Restart both: `Ctrl-C` on each, then `npm start` and `npm run worker` |
