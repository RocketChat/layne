---
slug: /
---

# Introduction

<div style={{textAlign: 'center'}}>
  <img src="/img/layne-logo.png" alt="Layne" width="120" />
</div>

Layne is a self-hosted GitHub App that centralizes security scanning across your organization's repositories. When a pull request is opened - or a workflow runs, depending on the configured trigger -, Layne automatically scans the changed files, posts the results as inline annotations on the GitHub Check Run, applies labels to the PR, and sends a chat notification if new issues are found.

Everything runs on your own infrastructure. No third-party CI service, no SaaS subscription.

```text title="> architecture"
                        ┌─────────────────────────────────┐
                        │      GITHUB PULL REQUEST        │◀────────────────────────┐
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
│└─────────────┘                      └────────────────┘ │  ┌────────────┐  │       │      │
│                                                        │─▶│   SEMGREP  │──┤       │      │
│                                                        │  └────────────┘  │       │      │
│                                                        │  ┌────────────┐  │  ┌──────────┐│
│                                                        ├─▶│   CLAUDE   │──┼─▶│ REPORTER ││
│                                                        │  └────────────┘  │  └──────────┘│
│                                                        │  ┌────────────┐  │              │
│                                                        ├─▶│   SPECTRE  │──┤              │
│                                                        │  └────────────┘  │              │
│                                                        │  ┌────────────┐  │              │
│                                                        └─▶│ DEP DOCTOR │──┘              │
│                                                           └────────────┘                 │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

## Why Layne?

When we started structuring the application security strategy at Rocket.Chat, we faced a challenge: as an open-source company with a limited budget, we wanted to leverage open-source tooling in a scalable way. We didn’t have access to GitHub Enterprise or any commercial security scanning solutions.

At first, we configured Semgrep and TruffleHog as GitHub Actions on our most critical repositories. As you might imagine, this quickly became difficult to manage.

After reading the [following article](https://web.archive.org/web/20250801064657/https://www.reddit.com/r/RedditEng/comments/1hks4f3/how_we_are_self_hosting_code_scanning_at_reddit/) by Reddit's team - they were facing a similar challenge, we've decided to implement a very similar solution to theirs. That's when Layne - named after one of our security engineers' dog - was born.

Layne makes it much easier to manage security scanning at scale without relying on commercial solutions. You can add Layne as a required check on pull requests across your repositories, configure open-source and/or custom scanners in a centralized way, set up notifications, and more.

This tool is continuously evolving: new features are added, and bugs are fixed regularly. We maintain Layne because it’s what we use every day at Rocket.Chat. If you see opportunities for improvement, feel free to open an issue or submit a pull request.
