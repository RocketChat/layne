# Configuration

Everything about how Layne behaves on a given repo lives in `config/layne.json`. Change it, restart both server and worker, and the new behaviour takes effect.

## Global Defaults

`$global` is a special key that sets organisation-wide defaults. Every repository Layne scans inherits these values. A per-repo entry only needs to specify what differs - everything else falls back to `$global`.

```json title="config/layne.json"
{
  "$global": {
    "semgrep": {
      "extraArgs": ["--config", "auto"]
    },
    "trufflehog": {
      "extraArgs": []
    },
    "trigger": {
      "on": "pull_request"
    },
    "labels": {
      "onFailure":       ["needs-security-review"],
      "removeOnFailure": ["security-ok"],
      "onSuccess":       ["security-ok"],
      "removeOnSuccess": ["needs-security-review"]
    },
    "notifications": {
      "rocketchat": {
        "enabled":    true,
        "webhookUrl": "$ROCKETCHAT_WEBHOOK_URL"
      }
    },
    "comment": {
      "enabled": false
    }
  }
}
```


## Per-Repo Configuration

Overrides are keyed by `"owner/repo"`. A repository with no entry - or whose entry omits a tool block - gets the global defaults:

| Tool | Default behaviour |
|---|---|
| Semgrep | Enabled - `semgrep scan --config auto --json <files>` |
| Trufflehog | Enabled - `trufflehog filesystem --json --no-update <files>` |
| Claude | Disabled - must opt in per repo |

See the individual scanner pages for full configuration options:
- [Semgrep](scanners/semgrep.md)
- [Trufflehog](scanners/trufflehog.md)
- [Claude](scanners/claude.md)

And for notifications and comments:
- [Notifiers](notifiers.md)
- [PR Comments](pr-comments.md)


## Override Behaviour by Key

Not all keys merge the same way when a per-repo entry overrides `$global`. The reason is intentional - some blocks like `labels` and `trigger` are semantically atomic (a partial label config makes no sense), while scanner blocks are designed to be tweaked one key at a time without repeating everything.

| Key | How per-repo overrides `$global` |
|---|---|
| `mode`, `contextLines`, `timeoutMinutes` | Per-repo value replaces global value |
| `semgrep`, `trufflehog`, `claude` | Merged at the key level - per-repo values overwrite matching keys, unset keys inherit from global |
| `trigger` | Full replacement - per-repo `trigger` replaces the global block entirely |
| `labels` | Full replacement - per-repo `labels` replaces the global block entirely |
| `notifications` | Per-notifier-key - per-repo `rocketchat` replaces global `rocketchat`; a per-repo `slack` entry stacks alongside a global `rocketchat` entry |
| `comment` | Merged at the key level - per-repo values overwrite matching keys, unset keys inherit from global |
| `exceptionApprovers` | Full replacement - per-repo `exceptionApprovers` replaces the global block entirely |


## Scan Mode

Controls how much of each changed file the scanners analyse.

```json title="config/layne.json"
{
  "$global": {
    "mode": "changed_files",
    "contextLines": 8
  }
}
```

### `mode`

| Value | Behaviour |
|---|---|
| `"changed_files"` | *(default)* Each scanner receives the full content of every file touched by the PR. Findings anywhere in those files are reported. |
| `"diff_only"` | A projected copy of each file is built containing only the changed hunks plus `contextLines` lines of surrounding context (blank lines preserve line numbers). Scanners receive the projected copy. After scanning, findings are filtered to lines that fall within the actual changed ranges. |

`diff_only` reduces noise and cost for large files where only a few lines changed. The tradeoff is that pre-existing issues in unchanged sections of the file are not reported.

:::warning Trufflehog in `diff_only` mode
Secrets that exist only in unchanged lines of a file will not appear in scan results. If full secret coverage is critical, set `mode: "changed_files"` for those repositories, or keep the global default as `changed_files` and only switch specific repos to `diff_only`.
:::

### `contextLines`

Number of surrounding lines to include around each changed hunk when `mode` is `"diff_only"`. Adjacent expanded hunks are merged into one region.

- **Default:** `8`
- Ignored when `mode` is `"changed_files"`

### `timeoutMinutes`

Hard time limit for a single scan job. If the limit is reached, the job is rethrown so BullMQ can retry it. The Check Run is only marked as failed on the final attempt.

- **Default:** `10`
- Accepts any positive integer

Raise this for large monorepos where Semgrep takes a long time, or lower it to fail fast on repos that should scan quickly.

```json title="config/layne.json"
{
  "$global": {
    "timeoutMinutes": 10
  },
  "org/monorepo": {
    "timeoutMinutes": 25
  }
}
```

### Examples

**Use `diff_only` globally, fall back to full scan for a compliance-critical repo:**

```json title="config/layne.json"
{
  "$global": {
    "mode": "diff_only",
    "contextLines": 8
  },
  "org/compliance-repo": {
    "mode": "changed_files"
  }
}
```

**Tighter context window for a high-volume monorepo:**

```json title="config/layne.json"
{
  "org/monorepo": {
    "mode": "diff_only",
    "contextLines": 3
  }
}
```


## Trigger

By default Layne scans every pull request immediately when it is opened, synchronised, or reopened (`pull_request` trigger). This is the right choice for private or internal repositories where all contributors are trusted and every PR is worth scanning.

For public repositories, two problems arise:

**1. Scanning unapproved contributions.** GitHub requires maintainer approval before running Actions for first-time external contributors. The `pull_request` event fires regardless - meaning Layne scans spam PRs, bot noise, and low-effort contributions that may never be reviewed.

**2. Wasted spend on failing code.** A PR that breaks CI within minutes is unlikely to merge. Scanning it burns Semgrep CPU time and - most importantly - Anthropic API credits on a result no one will act on.

The `workflow_run` and `workflow_job` triggers solve both by deferring the scan until after CI has run. You only scan code that cleared your quality gate.

### Cost impact

On a busy public repository, deferring to after CI passes can substantially reduce Claude API spend. PRs that fail CI quickly are never scanned. A 30-second CI failure gate that rejects 40% of PRs saves 40% of scan costs immediately.

### Choosing between `workflow_run` and `workflow_job`

| | `workflow_run` | `workflow_job` |
|---|---|---|
| Gates on | An entire workflow completing | A single named job completing |
| Use when | You want CI fully done before scanning | You have a fast early gate (e.g. lint, approval job) |
| Latency | Scan starts after the longest job in the workflow | Scan starts as soon as the named job finishes |

### Modes

| `on` | Behaviour |
|---|---|
| `pull_request` | *(default)* Scan fires immediately on `opened`, `synchronize`, and `reopened` |
| `workflow_run` | Scan fires when the named CI workflow completes with a matching conclusion |
| `workflow_job` | Scan fires when the named CI job completes with a matching conclusion |

### Schema

**`workflow_run`:**
```json title="config/layne.json"
{
  "owner/repo": {
    "trigger": {
      "on":          "workflow_run",
      "workflow":    "Tests Done",
      "conclusions": ["success"]
    }
  }
}
```

**`workflow_job`:**
```json title="config/layne.json"
{
  "owner/repo": {
    "trigger": {
      "on":          "workflow_job",
      "job":         "security-gate",
      "conclusions": ["success"]
    }
  }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `on` | `"pull_request"` \| `"workflow_run"` \| `"workflow_job"` | `"pull_request"` | When to trigger the scan |
| `workflow` | string | (none) | Workflow name to watch. Required when `on` is `"workflow_run"` |
| `job` | string | (none) | Job name to watch. Required when `on` is `"workflow_job"` |
| `conclusions` | string[] | `["success"]` | Workflow/job conclusions that trigger the scan |

### How deferred triggers work

Both `workflow_run` and `workflow_job` follow the same two-stage pattern:

1. **On `pull_request`** - Layne caches PR metadata in Redis (7-day TTL) and creates a `skipped` Check Run so the deferral is visible in the PR status UI. No scan is enqueued yet.
2. **On the trigger event completing** - When the named workflow or job finishes with a matching conclusion, Layne looks up the cached PR metadata and enqueues the scan. If the cache is cold (e.g. Layne was offline when the PR was opened), it falls back to the GitHub API.

### Failure mode

:::warning
If the watched workflow or job is renamed or removed, Layne never receives the trigger event and the scan never runs - silently. To fail **closed** rather than **open**, make Layne's Check Run a **required status check** in branch protection. A missing check blocks merging and the absence is immediately visible.
:::

### Examples

**Scan only after CI passes:**
```json title="config/layne.json"
{
  "owner/repo": {
    "trigger": {
      "on":       "workflow_run",
      "workflow": "Tests Done"
    }
  }
}
```

**Scan after a specific job (finer-grained):**
```json title="config/layne.json"
{
  "owner/repo": {
    "trigger": {
      "on":  "workflow_job",
      "job": "security-gate"
    }
  }
}
```

**Scan regardless of CI result (code is worth scanning even if tests fail):**
```json title="config/layne.json"
{
  "owner/repo": {
    "trigger": {
      "on":          "workflow_run",
      "workflow":    "Tests Done",
      "conclusions": ["success", "failure"]
    }
  }
}
```

**Apply a deferred trigger globally:**
```json title="config/layne.json"
{
  "$global": {
    "trigger": {
      "on":       "workflow_run",
      "workflow": "CI"
    }
  }
}
```


## Labels

Layne can automatically add and remove GitHub labels on a PR based on the scan result. Labels are applied after the Check Run is completed - label errors never affect the scan result.

### Configuration

```json title="config/layne.json"
{
  "$global": {
    "labels": {
      "onFailure":       ["needs-security-review"],
      "removeOnFailure": ["security-ok"],
      "onSuccess":       ["security-ok"],
      "removeOnSuccess": ["needs-security-review"]
    }
  }
}
```

| Key | When applied | Description |
|---|---|---|
| `onFailure` | Scan conclusion is `failure` | Labels to add to the PR |
| `removeOnFailure` | Scan conclusion is `failure` | Labels to remove from the PR |
| `onSuccess` | Scan conclusion is `success` | Labels to add to the PR |
| `removeOnSuccess` | Scan conclusion is `success` | Labels to remove from the PR |

All four keys are optional. Omitting a key is a no-op.

### Exception labels

When an exception approval is used, you can configure a label to be added:

```json title="config/layne.json"
{
  "$global": {
    "labels": {
      "onException":       ["security-exception-used"],
      "removeOnException": ["needs-security-review"]
    }
  }
}
```

| Key | When applied | Description |
|---|---|---|
| `onException` | Exception approved despite findings | Labels to add to the PR |
| `removeOnException` | Exception approved despite findings | Labels to remove from the PR |

### Label auto-creation

If a label listed in `onFailure`, `onSuccess`, or `onException` does not exist on the repository, Layne creates it automatically with a neutral gray colour (`#ededed`). You do not need to pre-create labels.

### Global vs per-repo

A per-repo `labels` block replaces the `$global` block entirely - it is not merged key-by-key. If neither `$global` nor the repo defines a `labels` key, the feature is a no-op for that repo.


## Exception Approvals

Configure specific users or teams who can approve PRs that would otherwise fail. See [Exception Approvals](./exception-approvals.md) for full documentation.

### Configuration

```json title="config/layne.json"
{
  "$global": {
    "exceptionApprovers": {
      "users": ["security-lead"],
      "teams": ["acme/security-team"]
    }
  }
}
```

| Key | Type | Description |
|---|---|---|
| `users` | string[] | GitHub usernames who can approve exceptions |
| `teams` | string[] | GitHub team slugs (format: `org/team-slug`) whose members can approve |

Per-repo `exceptionApprovers` replaces the global block entirely (not merged key-by-key).
