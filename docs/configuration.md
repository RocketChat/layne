# Configuration

Scanner behaviour, labels, notifications, and trigger conditions are all configured in `config/layne.json`. Layne reads this file once per process startup — **restart both server and worker to pick up changes** (the automated deploy pipeline does this automatically).

---

## Per-Repo Configuration

Overrides are keyed by `"owner/repo"`. Repositories with no entry — or whose entry omits a tool block — get the defaults:

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
| `prompt` | string | built-in | Custom system prompt (prompt mode only). Replaces the default malicious-intent prompt entirely |
| `skill` | object | `null` | Anthropic API Skill to load (skill mode). See below. When set, `prompt` is ignored |

> **Opt-in only.** Claude scanning is disabled by default to avoid unexpected API costs. Each repo must explicitly set `"enabled": true`. Requires `ANTHROPIC_API_KEY` to be set in the environment.

### Claude scanning modes

Claude supports two modes of operation, selected by what you set in the `claude` block. **`skill` takes precedence over `prompt`** — if both are set, skill mode runs and `prompt` is ignored (Layne will log a warning).

#### Prompt mode (default)

A single API call per file batch with a system prompt. Simple and works with any Claude model. Use this for most repos.

The built-in prompt instructs Claude to look for reverse shells, backdoors, credential exfiltration, obfuscated payloads, and supply-chain attacks. You can replace it entirely with `prompt` for domain-specific analysis:

```json
{
  "acme/payments": {
    "claude": {
      "enabled": true,
      "model": "claude-haiku-4-5-20251001",
      "prompt": "You are a security reviewer specialising in payment systems. Analyse the provided source files for malicious intent. Report ONLY confirmed malicious patterns with high confidence. Call `report_findings` with your results."
    }
  }
}
```

#### Skill mode

Uses the [Anthropic API Skills beta](https://platform.claude.com/docs/en/build-with-claude/skills-guide). An uploaded skill is loaded into a sandboxed container alongside a `code_execution` tool, allowing Claude to actually **run code** during analysis — decoding base64/hex payloads, querying npm/PyPI registry metadata, and doing deeper pattern matching than static reasoning alone allows.

```json
{
  "owner/repo": {
    "claude": {
      "enabled": true,
      "model": "claude-sonnet-4-6",
      "skill": { "id": "skill_01...", "version": "latest" }
    }
  }
}
```

`skill` object keys:

| Key | Type | Default | Description |
|---|---|---|---|
| `id` | string | — | Skill ID from the Anthropic Skills API (format: `skill_01...`) |
| `version` | string | `"latest"` | Skill version to use. Pin to a timestamp for reproducible behaviour |

> **Beta — expect breaking changes.** API Skills are in active development. The beta headers (`skills-2025-10-02`, `code-execution-2025-08-25`) may be superseded by Anthropic; when that happens, Layne will need to be updated to use the new headers before skill mode works again. Skill IDs (`skill_01...`) are opaque, tied to your Anthropic account, and are not portable — if Anthropic changes the Skills API in a way that invalidates existing uploads, you will need to re-upload your skill and update the `id` in `config/layne.json`.
>
> **Skills are not ZDR-eligible.** ZDR (Zero Data Retention) is an Anthropic compliance feature that guarantees prompts and outputs are not retained after the API call. Skills require data retention to function, so they cannot be used with ZDR-enabled Anthropic organizations. Use `claude-sonnet-4-6` or above — smaller models may not make effective use of code execution.

**Uploading a skill:** Skills are managed outside of Layne. To upload one:
```python
from anthropic import Anthropic
from anthropic.lib import files_from_dir

skill = Anthropic().beta.skills.create(
    display_title="Malicious Intent",
    files=files_from_dir("/path/to/skill-folder"),  # must contain SKILL.md
    betas=["skills-2025-10-02"],
)
print(skill.id)  # paste this into layne.json
```

### How args are assembled

```
semgrep scan <extraArgs> --json <absolute-file-paths...>
trufflehog filesystem --json --no-update <extraArgs> <absolute-file-paths...>
```

Arguments are passed directly via `execFile` — **not** through a shell — so no quoting or escaping is needed and shell injection is not possible.

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

**Use a custom system prompt for domain-specific analysis:**
```json
{
  "acme/payments": {
    "claude": {
      "enabled": true,
      "model": "claude-sonnet-4-6",
      "prompt": "You are a security reviewer specialising in payment systems. Analyse the provided source files for malicious intent: reverse shells, backdoors, credential exfiltration, and supply-chain attacks. Pay extra attention to anything that could exfiltrate card data or PII. Report ONLY confirmed malicious patterns with high confidence. Call `report_findings` with your results."
    }
  }
}
```

**Use an uploaded API Skill for deeper analysis (code execution, registry lookups):**
```json
{
  "acme/payments": {
    "claude": {
      "enabled": true,
      "model": "claude-sonnet-4-6",
      "skill": { "id": "skill_01...", "version": "latest" }
    }
  }
}
```

---

## Finding Suppression

### Why `// nosemgrep` is disabled

Layne passes `--disable-nosemgrep` to Semgrep on every scan (set in `$global.semgrep.extraArgs`). This prevents contributors from silencing findings inline without review — adding `// nosemgrep` in a PR would suppress the finding in that exact PR, bypassing the security review gate entirely.

### The replacement: `// SECURITY: <reason>`

Place a comment with a non-empty justification on the **same line** as the flagged code, or on the **line immediately above** it:

```js
// SECURITY: This eval call only runs trusted internal templates, never user input.
eval(internalTemplate);

const query = `SELECT * FROM users WHERE id = ${id}`; // SECURITY: id is always cast to integer by the ORM layer.
```

```yaml
# SECURITY: This token is intentionally committed — it is a public read-only CI token with no write access.
GITHUB_TOKEN: ghp_...
```

### The tamper-proof guarantee

The suppressor reads each file at the **merge-base SHA** of the PR (the three-dot diff base) via `git show`. A `// SECURITY:` comment added in the **current PR** is invisible to the suppressor — it is not in the base. The comment must have been reviewed, approved, and merged in a **previous PR** before it takes effect.

This means a contributor cannot self-approve a finding by adding the comment in their own PR.

### Syntax rules

- Comment style: `//` (JS/TS/Go/Java/C…) or `#` (YAML/shell/Python/Ruby…)
- The colon must be followed by at least one non-whitespace character: `// SECURITY: reason` ✓, `// SECURITY:` ✗
- Placement: same line as the finding **or** the line immediately above

### Workflow

1. Review the finding and decide it is a genuine false positive.
2. Add a `// SECURITY: <justification>` comment explaining why.
3. Submit a **separate PR** for the suppression comment, have it reviewed and merged.
4. From that point forward, any PR that triggers the same finding on that line will have it suppressed automatically.

### Keeping `--disable-nosemgrep` in per-repo `extraArgs`

`--disable-nosemgrep` is set in `$global.semgrep.extraArgs` and must be carried into any per-repo `extraArgs` override. If you set per-repo `extraArgs` without including `--disable-nosemgrep`, the flag will be absent for that repo — `extraArgs` fully replaces the default, it does not extend it (see [Replacement, not extension](#per-repo-configuration)).

```json
{
  "owner/repo": {
    "semgrep": {
      "extraArgs": ["--config", "p/owasp-top-ten", "--severity", "ERROR", "--disable-nosemgrep"]
    }
  }
}
```

---

## Labels

Layne can automatically add and remove GitHub labels on a PR based on the scan result. This gives at-a-glance triage context directly in the PR list view without opening each PR.

Labels are applied **after** the Check Run is completed. Errors never affect the scan result or the Check Run.

### Configuration

Add a `labels` key to `$global` or to any repo entry in `config/layne.json`:

```json
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
|-----|-------------|-------------|
| `onFailure` | Scan conclusion is `failure` | Labels to add to the PR |
| `removeOnFailure` | Scan conclusion is `failure` | Labels to remove from the PR |
| `onSuccess` | Scan conclusion is `success` | Labels to add to the PR |
| `removeOnSuccess` | Scan conclusion is `success` | Labels to remove from the PR |

All four keys are optional. Omitting a key is equivalent to an empty array (no-op).

### Label auto-creation

If a label listed in `onFailure` or `onSuccess` does not exist on the repository, Layne creates it automatically with a neutral gray color (`#ededed`). You do not need to pre-create labels.

### Global vs per-repo

`$global.labels` is the base; a per-repo `labels` block replaces the global config at the whole-key level.

```json
{
  "$global": {
    "labels": {
      "onFailure":       ["needs-security-review"],
      "removeOnSuccess": ["needs-security-review"]
    }
  },
  "acme/payments": {
    "labels": {
      "onFailure":       ["security-critical"],
      "removeOnSuccess": ["security-critical"]
    }
  }
}
```

If neither `$global` nor the repo defines a `labels` key, the feature is a no-op for that repo.

---

## Trigger

By default Layne scans every pull request immediately when it is opened, synchronised, or reopened (`pull_request` trigger). This is the right choice for private or internal repositories where all contributors are trusted and every PR is worth scanning.

For public repositories, two problems arise:

**1. GitHub workflow approval gates.** GitHub requires maintainer approval before running Actions workflows for first-time external contributors. This means Layne's `pull_request` event fires and the scan starts running — spawning Semgrep processes, Trufflehog processes, and Anthropic API calls — on code that may never actually execute in CI because a maintainer hasn't approved it yet. You end up scanning throwaway spam PRs, bot noise, and low-effort contributions that will be closed without review.

**2. Wasted spend on failing code.** Even for trusted contributors, a PR that immediately breaks CI is unlikely to be merged. Scanning it early means burning Semgrep CPU time, Trufflehog I/O, and — most importantly — Anthropic API credits on code that will need to be revised anyway. If CI runs for 5 minutes and fails on a type error, the security scan result is moot.

The `workflow_run` and `workflow_job` triggers solve both problems by deferring the scan until after CI has already run. You only scan code that cleared your quality gate, which is almost always the only code that will ever land in your main branch.

### Cost impact

The Claude adapter makes Anthropic API calls charged per token. On a busy public repository, the difference between scanning every PR immediately and scanning only after CI passes can be significant:

- Repositories with high external contributor volume often receive many low-quality PRs (spam, trivial fixes, automated dependency bumps that fail tests). These will never merge and don't need security scanning.
- PRs that fail CI within the first few minutes consume scan compute for a result no one will act on. A 30-second CI failure gate that rejects 40% of PRs saves 40% of scan costs immediately.
- Semgrep and Trufflehog are cheap (CPU only), but the Claude adapter is billed per token at Anthropic API rates. On a repo with many PRs per day, this adds up quickly. Deferring to after CI passes is the single most effective cost control available.

The deferred triggers do not reduce security coverage for PRs that pass CI — the scan still runs on every commit that clears the gate, before merge.

### Choosing between `workflow_run` and `workflow_job`

| | `workflow_run` | `workflow_job` |
|---|---|---|
| Gates on | An entire workflow completing | A single named job completing |
| Use when | You want CI fully done before scanning | You have a fast early gate (e.g. lint, approval job) and want to scan sooner |
| Latency | Scan starts after the longest job in the workflow | Scan starts as soon as the named job finishes |
| Typical setup | One CI workflow, wait for all of it | A dedicated `security-gate` job that runs approval checks early |

### Modes

| `on` | Behaviour |
|---|---|
| `pull_request` | *(default)* Scan fires immediately on `opened`, `synchronize`, and `reopened` events |
| `workflow_run` | Scan fires when the named CI workflow completes with a matching conclusion |
| `workflow_job` | Scan fires when the named CI job completes with a matching conclusion |

### Schema

**`workflow_run`:**
```json
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
```json
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
| `workflow` | string | — | Name of the GitHub Actions workflow to watch. Required when `on` is `"workflow_run"` |
| `job` | string | — | Name of the GitHub Actions job to watch. Required when `on` is `"workflow_job"` |
| `conclusions` | string[] | `["success"]` | Conclusions that trigger the scan. Valid values: `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required` |

> **`trigger` can be set globally.** Set it under `$global` to apply to all repos, then override per-repo as needed.

### How deferred triggers work

Both `workflow_run` and `workflow_job` follow the same two-stage pattern:

1. **On `pull_request`** — Layne caches the PR metadata in Redis (7-day TTL) and creates a `skipped` Check Run so the deferral is visible in the PR status UI. No scan is enqueued yet.
2. **On the trigger event completing** — When the named workflow or job finishes with a matching conclusion, Layne looks up the cached PR metadata and enqueues the scan. If the cache is cold (e.g. Layne was offline when the PR was opened), Layne falls back to the GitHub API to find the associated PR.

### Failure mode

If the watched workflow or job is renamed or removed, Layne never receives the event and the scan never runs. To fail **closed** (safe) rather than **open** (silent), make Layne's Check Run a **required status check** in branch protection — then a missing check blocks merging and the absence is immediately visible.

### Examples

**Scan only after CI passes (mirrors GitHub's "require approval for workflows" gate):**
```json
{
  "owner/repo": {
    "trigger": {
      "on":       "workflow_run",
      "workflow": "Tests Done"
    }
  }
}
```

**Scan after a specific job completes (finer-grained than a whole workflow):**
```json
{
  "owner/repo": {
    "trigger": {
      "on":  "workflow_job",
      "job": "security-gate"
    }
  }
}
```

**Scan regardless of whether CI passes or fails (workflow was approved, code is worth scanning):**
```json
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

**Apply workflow_run trigger to all repos globally:**
```json
{
  "$global": {
    "trigger": {
      "on":       "workflow_run",
      "workflow": "CI"
    }
  }
}
```

---

## Notifications

Layne can send a notification to a chat webhook when a scan finds new issues. Notifications fire after the GitHub Check Run is fully posted — engineers see the check result first, then receive the alert.

Notifications are **opt-in** and **modular**: each notifier (e.g. Rocket.Chat) is an independent module. See [Extending Layne](extending.md) for how to add a new provider.

### Deduplication

Layne only notifies when the finding count **increases** compared to the previous scan for the same PR. If a developer pushes a new commit that doesn't introduce new findings, no notification is sent. The previous count is stored in Redis with a 30-day TTL. A Redis read error is treated as a previous count of zero (fail open).

### Global vs per-repo

You can define a **global** notification config that applies to all repositories, and/or a **per-repo** override for specific repositories. Both are optional — if neither is defined, no notifications are sent and nothing breaks.

**Resolution rules (per notifier key):**
- If a repo has no `notifications` block → it inherits the global config entirely.
- If a repo defines its own `notifications` block → its keys win over the global ones for matching notifiers.
- A repo can opt out of a specific global notifier by setting `"enabled": false` for that notifier.
- If both global and the repo define *different* notifier keys, both are active (e.g. global Rocket.Chat + repo-specific Slack).

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
| `template` | string | no | Custom message template (see below). Omit for the default format |

**`webhookUrl` — keeping secrets out of `config/layne.json`:**

If the value starts with `$`, Layne treats the rest as an environment variable name and reads it at runtime. This way your webhook URL never needs to be committed to the repository.

```json
"webhookUrl": "$ROCKETCHAT_WEBHOOK_URL"
```

If the env var is not set, Layne logs a warning and skips the notification — the scan result is unaffected.

**Message icon:**

Layne automatically sets its logo as the message icon (`icon_url`) using the `DOMAIN` environment variable. No configuration is required — if `DOMAIN` is set, every Rocket.Chat notification will show the Layne logo. The logo is served at `GET /assets/layne-logo.png`.

**Default message format:**

```
🦴 Good boy Layne dug up 3 finding(s) in https://github.com/acme/payments/pull/42
```

**Custom template:**

Set `template` to a string with `{{variable}}` placeholders:

| Placeholder | Value |
|---|---|
| `{{prUrl}}` | Full PR URL, e.g. `https://github.com/acme/payments/pull/42` |
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

### Slack

Sends a POST request to a Slack incoming webhook URL.

| Key | Type | Required | Description |
|---|---|---|---|
| `enabled` | boolean | yes | Must be `true` to activate this notifier |
| `webhookUrl` | string | yes | Webhook URL, or an env var reference like `"$SLACK_WEBHOOK_URL"` |
| `template` | string | no | Custom message template (see below). Omit for the default format |

**Setting up a Slack incoming webhook:**

Create a Slack app, enable Incoming Webhooks, and add a webhook for your channel. Copy the resulting `https://hooks.slack.com/services/...` URL.

**`webhookUrl` — keeping secrets out of `config/layne.json`:**

Same `$ENV_VAR` resolution as Rocket.Chat — if the value starts with `$`, Layne reads it from the environment at runtime.

```json
"webhookUrl": "$SLACK_WEBHOOK_URL"
```

**Default message format:**

```
🦴 Good boy Layne dug up 3 finding(s) in <https://github.com/acme/payments/pull/42|acme/payments #42>
```

The PR link uses Slack's `<url|label>` syntax so it renders as a clickable hyperlink.

**Custom template:**

Same `{{variable}}` placeholders as Rocket.Chat (see table above). You can use Slack's mrkdwn formatting in your template:

```json
"template": ":rotating_light: *{{repo}} PR #{{prNumber}}* — {{total}} finding(s): {{critical}} critical, {{high}} high"
```

---

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

---

## PR Comments

Layne can post a comment directly on the PR when a scan finds security issues. The comment appears inline in the PR thread and is updated in-place on each re-push — Layne never creates duplicate comments.

**On success after failure:** If a subsequent push clears all findings, Layne updates the existing comment to show "scan passed". If the scan passes and there was no prior failure comment, nothing is posted.

### Configuration

Add a `comment` key to `$global` or to any repo entry in `config/layne.json`:

```json
{
  "$global": {
    "comment": {
      "enabled": false,
      "template": null
    }
  },
  "owner/repo": {
    "comment": { "enabled": true }
  }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Must be `true` to post PR comments for this repo |
| `template` | string \| null | `null` | Custom Markdown template for the failure comment. Omit (or set to `null`) for the default format |

### Global vs per-repo

Same merge rules as notifications: a repo with no `comment` block inherits the global config entirely; per-repo keys win over global ones for any key that is set.

```json
{
  "$global": {
    "comment": { "enabled": true }
  },
  "acme/low-signal-repo": {
    "comment": { "enabled": false }
  }
}
```

### Default comment format

When a scan finds issues, Layne posts:

```markdown
<!-- layne-security-scan -->
## 🔴 Layne — 3 finding(s)

Found 3 issue(s): 1 high, 2 medium.
```

On a subsequent clean push, Layne updates that comment to:

```markdown
<!-- layne-security-scan -->
✅ **Layne — scan passed**

No security issues found on latest push.
```

### Custom template

Set `template` to a Markdown string with `{{variable}}` placeholders:

| Placeholder | Value |
|---|---|
| `{{prUrl}}` | Full PR URL, e.g. `https://github.com/acme/payments/pull/42` |
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

> **Important:** The `<!-- layne-security-scan -->` HTML comment must be present in any custom template. Layne uses it as a marker to find and update the existing comment on re-pushes. Without it, Layne will create a new comment on every scan.

Example:

```json
{
  "acme/payments": {
    "comment": {
      "enabled": true,
      "template": "<!-- layne-security-scan -->\n## Security findings for {{repo}} PR #{{prNumber}}\n\n{{summary}}\n\nSee the [Check Run]({{prUrl}}) for details."
    }
  }
}
```
