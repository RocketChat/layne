# Configuration

Scanner behaviour, labels, and notifications are all configured in `config/repos.json`. Layne reads this file once at worker startup — **restart the worker to pick up changes** (the automated deploy pipeline does this automatically).

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

> **Opt-in only.** Claude scanning is disabled by default to avoid unexpected API costs. Each repo must explicitly set `"enabled": true`. Requires `ANTHROPIC_API_KEY` to be set in the environment.

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

---

## Labels

Layne can automatically add and remove GitHub labels on a PR based on the scan result. This gives at-a-glance triage context directly in the PR list view without opening each PR.

Labels are applied **after** the Check Run is completed. Errors never affect the scan result or the Check Run.

### Configuration

Add a `labels` key to `$global` or to any repo entry in `config/repos.json`:

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

**`webhookUrl` — keeping secrets out of `repos.json`:**

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
