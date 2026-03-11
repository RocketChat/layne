# Layne

<p align="center">
  <img src="assets/layne-logo.png" alt="Layne logo" width="160" />
</p>

> Layne is a self-hosted GitHub App that centralises security scanning across our repositories. Since we don't use commercial SAST/secrets scanning tools, nor we have access to GitHub Enterprise, it can get hard to maintain different GitHub Actions workflow files across different repositories - especially as such repositories grow in number. Instead, we install Layne once and it listens for pull request events, runs our security tools server-side, posts the results back as native GitHub Check Run annotations, and notifies our security team's security notifications channel.

This tool was based on [Reddit's Implementation](https://web.archive.org/web/20250801064657/https://www.reddit.com/r/RedditEng/comments/1hks4f3/how_we_are_self_hosting_code_scanning_at_reddit/).

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

## Documentation

- [**Configuration**](docs/configuration.md) — per-repo scanner settings, PR labels, and chat notifications
- [**Metrics**](docs/metrics.md) — Prometheus metrics and the bundled Grafana dashboard
- [**Deployment**](docs/deployment.md) — initial setup on EC2, CI/CD pipeline, and day-to-day operations
- [**Extending Layne**](docs/extending.md) — adding new scanners and notification providers
- [**Reference**](docs/reference.md) — environment variables, finding shape, severity levels, and queue behaviour
