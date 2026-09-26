# Configuration

Everything about how Layne behaves on a given repo lives in `config/layne.json`. Change it, restart both server and worker, and the new behavior takes effect.

## Global Defaults

`$global` is a special key that sets organization-wide defaults. Every repository Layne scans inherits these values. A per-repo entry only needs to specify what differs - everything else falls back to `$global`.

```json title="config/layne.json"
{
  "$global": {
    "mode": "changed_files",
    "contextLines": 8,
    "timeoutMinutes": 10,
    "semgrep": {
      "enabled": true,
      "extraArgs": ["--config", "auto"]
    },
    "trufflehog": {
      "enabled": true,
      "extraArgs": []
    },
    "trigger": {
      "on": "pull_request"
    },
    "labels": {
      "onFailure":        ["needs-security-review"],
      "removeOnFailure":  ["security-ok"],
      "onSuccess":        ["security-ok"],
      "removeOnSuccess":  ["needs-security-review"],
      "onIncomplete":     ["security-scan-incomplete"],
      "removeOnIncomplete": ["security-ok"],
      "onException":      ["security-exception-used"],
      "removeOnException": ["needs-security-review"]
    },
    "notifications": {
      "rocketchat": {
        "enabled":    true,
        "webhookUrl": "$ROCKETCHAT_WEBHOOK_URL"
      }
    },
    "comment": {
      "enabled":  false,
      "template": null
    },
    "exceptionApprovers": {
      "users": ["security-lead"],
      "teams": ["acme/security-team"]
    }
  }
}
```


## Per-Repo Configuration

Overrides are keyed by `"owner/repo"`. A repository with no entry - or whose entry omits a tool block - gets the global defaults:

| Tool | Default behavior |
|---|---|
| Semgrep | Enabled - `semgrep scan --config auto --json <files>` |
| Trufflehog | Enabled - `trufflehog filesystem --json --no-update <files>` |
| Claude | Disabled - must opt in per repo; requires `ANTHROPIC_API_KEY` |
| Spectre | Disabled - must opt in per repo. Setting `enabled: true` without a valid `provider` produces incomplete coverage; an enabled provider also requires the corresponding credentials in the environment |
| Dep Doctor | Disabled - must opt in per repo; requires `osv-scanner` in PATH for CVE scanning |

See the individual scanner pages for full configuration options:
- [Semgrep](scanners/semgrep.md)
- [Trufflehog](scanners/trufflehog.md)
- [Claude](scanners/claude.md)
- [Spectre](scanners/spectre.md)
- [Dep Doctor](scanners/dep-doctor.md)

And for notifications and comments:
- [Notifiers](notifiers.md)
- [PR Comments](pr-comments.md)


## Override Behavior by Key

Not all keys merge at the same depth when a per-repo entry overrides `$global`. Scanner, trigger, comment, and label blocks merge their individual options; notification blocks merge one notifier at a time; exception approvers are replaced as a unit.

| Key | How per-repo overrides `$global` |
|---|---|
| `mode`, `contextLines`, `timeoutMinutes`, `maxFileSizeKb`, `maxLockfileSizeKb` | Per-repo value replaces global value |
| `semgrep`, `trufflehog`, `claude`, `spectre`, `depDoctor` | Merged at the key level - per-repo values overwrite matching keys, unset keys inherit from global |
| `trigger` | Merged at runtime, but each configured block must be independently valid; repeat `on` and its required `workflow`/`job` when overriding |
| `labels` | Merged at the key level - per-repo label actions overwrite matching actions |
| `notifications` | Per-notifier-key - per-repo `rocketchat` replaces global `rocketchat`; a per-repo `slack` entry stacks alongside a global `rocketchat` entry |
| `comment` | Merged at the key level - per-repo values overwrite matching keys, unset keys inherit from global |
| `exceptionApprovers` | Full replacement - per-repo `exceptionApprovers` replaces the global block entirely |


## Scan Mode

Controls the workspace presented to file-oriented scanners. Semgrep always parses complete selected HEAD files and is post-filtered to exact changed lines in `diff_only` mode. Claude always receives prepared changed-hunk snippets, and Spectre always receives the canonical typed base-to-head unified diff, in both modes.

```json title="config/layne.json"
{
  "$global": {
    "mode": "diff_only",
    "contextLines": 8
  }
}
```

### `mode`

| Value | Behavior |
|---|---|
| `"changed_files"` | *(default)* Semgrep, Trufflehog, and other file-oriented scanners receive complete changed files. Their findings may be anywhere in those files. Claude receives prepared hunk snippets; Spectre receives the typed unified diff. |
| `"diff_only"` | A projected copy containing changed hunks plus `contextLines` is built for Trufflehog and projection-oriented file scanners. Semgrep parses complete selected HEAD files to preserve valid syntax. Findings from file scanners are filtered to exact changed ranges. Claude receives prepared hunk snippets; Spectre receives the typed unified diff. |

`diff_only` reduces noise and cost for large files where only a few lines changed. The tradeoff is that pre-existing issues in unchanged sections of the file are not reported.

:::warning Trufflehog in `diff_only` mode
Secrets that exist only in unchanged lines of a file will not appear in scan results. If full secret coverage is critical, set `mode: "changed_files"` for those repositories, or keep the global default as `changed_files` and only switch specific repos to `diff_only`.
:::

### `contextLines`

Number of surrounding HEAD lines to include around each changed hunk. Adjacent expanded hunks are merged into one region.

- **Default:** `8`
- Used by Claude's prepared snippets and Spectre's canonical unified diff in both modes; also used by projection-oriented file scanners when `mode` is `"diff_only"`. It does not limit Semgrep's parsing context.

### `timeoutMinutes`

Hard time limit for a single scan job. If the limit is reached before terminal Check Run publication, the job is rethrown so BullMQ can retry it, and the Check Run is only marked failed on the final attempt. If publication already completed, the deadline aborts remaining best-effort side effects without retrying the job.

- **Default:** `15`
- Accepts any positive integer

Raise this for large monorepos where scanners may take a long time, or lower it to fail fast on repos that should scan quickly.

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

### `maxFileSizeKb`

Maximum full HEAD file size admitted by the dispatcher.

- **Default:** `1024`
- Accepts any positive integer

Files above the limit are excluded before Semgrep, Trufflehog, Claude, and Spectre run. For Semgrep, Trufflehog, and Claude, this is a configured selection policy and does not by itself make their result incomplete. Spectre applies its built-in code-bearing eligibility filter first; intentionally excluded prose is skipped without size accounting. Eligible Spectre files omitted by the size limit are recorded in its coverage counters and make the result `incomplete`. Dep Doctor uses the separate lockfile limit below.

### `maxLockfileSizeKb`

Maximum changed HEAD lockfile size admitted to Dep Doctor.

- **Default:** `4096` (4 MiB)
- Accepts any positive integer

Recognized lockfiles above this limit are reported as incomplete dependency coverage. This higher limit does not increase `maxFileSizeKb`: a lockfile between 1 MiB and 4 MiB is available to Dep Doctor but remains excluded from the ordinary file-scanner inputs.

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


## Spectre Budgets

Spectre uses typed unified diffs, analyzes the whole selected PR in one request when it fits, and otherwise creates file/hunk chunks. The following limits are merged through `$global` and per-repository `spectre` blocks. See [Spectre](scanners/spectre.md) for file selection, providers, incomplete outcomes, and evaluator operations.

| Key | Default | Hard maximum | Scope |
|---|---:|---:|---|
| `fileCap` | `20` | `30` | Primary files selected after deterministic risk scoring |
| `secondaryFileCap` | `20` | `50` | Additional related or risk-scored files |
| `maxInputBytes` | `65536` | `65536` | UTF-8 bytes in each request's user payload; excludes the system prompt |
| `maxOutputTokens` | `1200` | `2000` | Generated tokens for each provider request |
| `requestTimeoutSeconds` | `30` | `30` | Deadline for each provider request |
| `maxCallsPerFile` | `4` | `20` | Admitted chunks associated with one file |
| `maxCallsPerPullRequest` | `40` | `100` | Provider calls for one pull request |
| `maxRepairCallsPerPullRequest` | `3` | `10` | Additional targeted response/evidence repair calls per pull request; `0` disables repair |
| `astSignals.maxFiles` | `200` | `500` | Files admitted to optional structural routing |
| `astSignals.maxTotalBytes` | `2097152` | `67108864` | Total UTF-8 bytes parsed by structural routing |
| `astSignals.timeoutSeconds` | `3` | `30` | Structural analysis deadline |

`maxDiffLines` also limits each chunk to 400 diff lines by default and has a hard maximum of 1000. Limits that prevent complete analysis produce an incomplete result; they do not produce a clean pass. If the selected-file caps leave any score-12-or-higher file unscanned, the incomplete result is a blocking coverage failure. Lower-risk file-cap overflow and other incomplete reasons remain neutral when no blocking finding exists.

Structural routing is configured with `astSignals.mode`: `off` (default) preserves lexical selection, `shadow` records structural diagnostics without changing selection or coverage, and `enabled` selects from the union of lexical and changed-span structural signals. `$global` and repository `astSignals` objects merge key by key. Internal structural parser or worker failures fall back to lexical routing.


## Trigger

By default Layne scans non-draft pull requests when they are opened, synchronised, reopened, or marked ready for review (`pull_request` trigger). Draft pull requests are ignored unless `trigger.scanOnDraft` is enabled.

For public repositories, two problems arise:

**1. Scanning unapproved contributions.** Your GitHub organization may require maintainer approval before running Actions for first-time external contributors. The `pull_request` event fires regardless - meaning Layne scans spam PRs, bot noise, and low-effort contributions that may never be reviewed.

**2. Wasted spend on failing code.** A PR that breaks CI within minutes is unlikely to merge. Scanning it burns Semgrep CPU time and - most importantly, if you're using Claude or another AI provider - credits on a result no one will act on.

The `workflow_run` and `workflow_job` triggers solve both by deferring the scan until after CI has run. You only scan code that cleared your quality gate.

Long story short, you can choose between the following:

| `on` | Behavior |
|---|---|
| `pull_request` | *(default)* Scan fires immediately on `opened`, `synchronize`, `reopened`, and `ready_for_review` for eligible PRs |
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
| `scanOnDraft` | boolean | `false` | Allow draft PRs to scan; applies to all trigger modes |
| `workflow` | string | (none) | Workflow name to watch. Required when `on` is `"workflow_run"` |
| `job` | string | (none) | Job name to watch. Required when `on` is `"workflow_job"` |
| `conclusions` | string[] | `["success"]` | Workflow/job conclusions that trigger the scan |

### How deferred triggers work

Both `workflow_run` and `workflow_job` follow the same two-stage pattern:

1. **On `pull_request`** - Layne caches PR metadata in Redis (7-day TTL) and creates a `skipped` Check Run so the deferral is visible in the PR status UI. No scan is enqueued yet.
2. **On the trigger event completing** - When the named workflow or job finishes with a matching conclusion, Layne looks up the cached PR metadata and enqueues the scan. If the cache is cold (e.g. Layne was offline when the PR was opened), it falls back to the GitHub API.

With the default `scanOnDraft: false`, draft PR events are not cached or deferred. The watched GitHub Actions workflow must include `ready_for_review` in its `pull_request.types` so marking the PR ready starts a new workflow or job:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
```

Setting `scanOnDraft: true` allows matching `pull_request`, `workflow_run`, and `workflow_job` triggers to scan drafts. Deferred triggers still require the configured workflow or job conclusion.

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
      "removeOnSuccess": ["needs-security-review"],
      "onIncomplete":    ["security-scan-incomplete"],
      "removeOnIncomplete": ["security-ok"]
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
| `onIncomplete` | Scan conclusion is `neutral` because coverage is incomplete | Labels to add to the PR |
| `removeOnIncomplete` | Scan conclusion is `neutral` because coverage is incomplete | Labels to remove from the PR |

All keys are optional. Omitting a key is a no-op. Incomplete adapter or Git content coverage normally produces `neutral` when there is no blocking finding. Blocking findings retain `failure` precedence. Spectre's `high-risk-file-cap-exceeded` coverage condition also produces `failure`, so `onFailure`/`removeOnFailure` apply even when no finding was created for the omitted files.

### Exception labels

When an exception approval is used, you can configure a label to be added or removed:

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
| `onException` | Exception approved and final conclusion is `success` | Labels to add to the PR |
| `removeOnException` | Exception approved and final conclusion is `success` | Labels to remove from the PR |

Incomplete coverage takes precedence over exception labels. If all blocking findings are excepted but ordinary adapter coverage is incomplete, the final conclusion is `neutral` and Layne uses `onIncomplete`/`removeOnIncomplete` instead. If Spectre has `high-risk-file-cap-exceeded`, the final conclusion remains `failure` and Layne uses `onFailure`/`removeOnFailure`.

### Label auto-creation

If a label Layne needs to add does not exist on the repository, Layne creates it automatically with a neutral gray color (`#ededed`). You do not need to pre-create labels.

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
