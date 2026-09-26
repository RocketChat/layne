# Notifiers

Layne can send a message to a chat platform when a scan reaches a security-relevant state. Notifications fire after the GitHub Check Run is posted and are independent of it - a notification failure never affects the scan result.

Notifiers are configured under the `notifications` key in `config/layne.json`.


## Events and defaults

By default, Layne notifies for critical/high findings, final internal errors, and exception approvals. Coverage-only updates and medium, low, and info findings remain visible in the Check Run and PR comment but do not notify by default.

| Event | Meaning |
|---|---|
| `findings` | Findings at or above `minFindingSeverity` |
| `coverage-failure` | Required coverage failed and blocked the check, such as Spectre omitting a high-risk file (opt in) |
| `incomplete-scan` | Scanner, Git, or diff coverage was incomplete (opt in) |
| `internal-error` | The final BullMQ attempt failed before completing the scan |
| `exception-approval` | One or more effective blocking-finding exceptions exist |

Configure the policy per notifier:

```json
{
  "enabled": true,
  "webhookUrl": "$ROCKETCHAT_WEBHOOK_URL",
  "notifyOn": ["findings", "coverage-failure", "incomplete-scan", "internal-error", "exception-approval"],
  "minFindingSeverity": "high"
}
```

Set `minFindingSeverity` to `medium`, `low`, or `info` to opt into non-blocking finding notifications.

Add `coverage-failure` and/or `incomplete-scan` to `notifyOn` when a notifier should receive coverage updates. Once `notifyOn` is set, list every event that notifier should receive because the array replaces the default policy.

## Deduplication and retries

Layne fingerprints the final conclusion, relevant finding IDs and severities, coverage reasons, and effective exceptions. Each notifier and PR has an independent Redis cursor with a 30-day TTL. Reordered or unchanged results do not notify, while a same-count replacement finding or severity escalation does.

A clean state is recorded without sending a recovery message. If a failure later returns, it notifies again. Transient network errors, HTTP 408/425/429, and HTTP 5xx responses are attempted up to three times. A failed delivery is not acknowledged, so a later scan with the same applicable state retries it. Delivery is at-least-once; a process crash after the remote webhook accepts a request but before Redis is updated can produce a duplicate.

The first scan of an existing open PR after upgrading from count-based deduplication uses the new state cursor and may send one fresh notification. The old `layne:scan:count:*` keys are not migrated because they do not contain finding identities or coverage state; they expire under their existing TTL.

## Exception Approval Notifications

Effective partial and full exception approvals notify. When another configured event also applies, its status appears on a separate line so the approval cannot imply that the PR passed.

The notification includes the approver's username:

```
ℹ️ Exception approved by @security-lead for https://github.com/acme/payments/pull/42
❗ Required scan coverage failed for https://github.com/acme/payments/pull/42: spectre: omitted-high-risk-file (1)
```

You can customise the notification using the exception template variables below.


## Global vs per-repo

Notifications use per-notifier-key merging:

- A per-repo `rocketchat` block **replaces** the global `rocketchat` block.
- A per-repo `slack` block **stacks alongside** a global `rocketchat` block - both fire.
- A repo can opt out of a global notifier by setting `"enabled": false` for that key.
- If neither `$global` nor the repo defines a `notifications` block, no notifications are sent.

See [Configuration](./configuration.md#override-behavior-by-key) for the full override behavior table.


## Template variables

All notifiers support a `template` field with `{{variable}}` placeholders. The available variables are:

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
| `{{info}}` | Count of info findings |
| `{{summary}}` | Pre-rendered summary line, e.g. `Found 2 issue(s): 1 high, 1 medium.` |
| `{{severitySummary}}` | Severity counts as a comma-separated string, e.g. `1 high, 2 medium` |
| `{{findings}}` | Pre-rendered findings table (Severity, Scanner, File with line, Rule, Description) - primarily useful in PR comment templates |
| `{{approver}}` | GitHub username of the exception approver (only set when an exception is used) |
| `{{approvedFindingIds}}` | Comma-separated effective exception finding IDs |
| `{{approvalReason}}` | Recorded exception reason or reasons |
| `{{event}}` | Primary notification event |
| `{{events}}` | All events represented by this notification |
| `{{conclusion}}` | Final Check Run conclusion |
| `{{notificationTotal}}` | Finding count at or above the notifier's `minFindingSeverity`, excluding effective exceptions |
| `{{blockingTotal}}` | Unexcepted critical/high finding count |
| `{{warningTotal}}` | Medium/low/info finding count |
| `{{coverageSummary}}` | Scanner, Git, and diff coverage reasons |
| `{{blockingCoverageSummary}}` | Required blocking coverage failures |
| `{{incompleteCoverageSummary}}` | Incomplete scanner, Git, and diff coverage reasons |
| `{{stateSummary}}` | Combined summary of every event represented by the notification |
| `{{errorId}}` | Sanitized internal-error correlation ID |

Omit `template` and `templates` to use the built-in message format. Every applicable event is rendered as a standalone line in priority order: internal error, exception approval, required coverage failure, findings, then incomplete coverage. A configured global `template`, or a `templates` entry for the primary event, retains the custom single-message behavior.


## Keeping webhook URLs out of config

If a `webhookUrl` value starts with `$`, Layne resolves it from `process.env` at runtime. This keeps secrets out of `config/layne.json`:

```json title="config/layne.json"
"webhookUrl": "$ROCKETCHAT_WEBHOOK_URL"
```

If the referenced environment variable is not set, Layne logs a warning and skips the notification - the scan result is unaffected.


---

## Rocket.Chat

Sends a POST to a Rocket.Chat incoming webhook URL.

| Key | Type | Required | Description |
|---|---|---|---|
| `enabled` | boolean | yes | Must be `true` to activate |
| `webhookUrl` | string | yes | Webhook URL, or `"$ENV_VAR"` reference |
| `template` | string | no | Custom message template. Omit for the default format |
| `templates` | object | no | Event-specific templates keyed by notification event |
| `notifyOn` | string[] | no | Enabled events; defaults to `findings`, `internal-error`, and `exception-approval` |
| `minFindingSeverity` | string | no | Minimum severity for `findings`; defaults to `high` |

**Built-in event lines:**
```
🚨 Layne encountered internal error 7e6638d43848 while scanning https://github.com/acme/payments/pull/42
ℹ️ Exception approved by @security-lead for https://github.com/acme/payments/pull/42
❗ Required scan coverage failed for https://github.com/acme/payments/pull/42: spectre: omitted-high-risk-file (1)
🦴 Good boy Layne dug up 3 finding(s) in https://github.com/acme/payments/pull/42
❗ Scan coverage was incomplete for https://github.com/acme/payments/pull/42: semgrep: partial-results (1)
```

Only configured events that apply to the scan are included. When several apply, each line repeats the PR URL so it remains meaningful on its own.

**Message icon:** Layne automatically sets its logo as the message icon using the `DOMAIN` environment variable. No configuration needed - if `DOMAIN` is set, the Layne logo appears on every notification.

**Custom template example:**
```json
"template": ":rotating_light: *{{repo}} PR #{{prNumber}}* - {{total}} finding(s): {{critical}} critical, {{high}} high"
```

**Schema:**
```json title="config/layne.json"
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


---

## Slack

Sends a POST to a Slack incoming webhook URL.

| Key | Type | Required | Description |
|---|---|---|---|
| `enabled` | boolean | yes | Must be `true` to activate |
| `webhookUrl` | string | yes | Webhook URL, or `"$ENV_VAR"` reference |
| `template` | string | no | Custom message template. Omit for the default format |
| `templates` | object | no | Event-specific templates keyed by notification event |
| `notifyOn` | string[] | no | Enabled events; defaults to `findings`, `internal-error`, and `exception-approval` |
| `minFindingSeverity` | string | no | Minimum severity for `findings`; defaults to `high` |

**Setup:** Create a Slack app, enable Incoming Webhooks, add a webhook for your channel, and copy the resulting `https://hooks.slack.com/services/...` URL.

**Built-in event lines:**
```
🚨 Layne encountered internal error 7e6638d43848 while scanning <https://github.com/acme/payments/pull/42|acme/payments #42>
ℹ️ Exception approved by @security-lead for <https://github.com/acme/payments/pull/42|acme/payments #42>
❗ Required scan coverage failed for <https://github.com/acme/payments/pull/42|acme/payments #42>: spectre: omitted-high-risk-file (1)
🦴 Good boy Layne dug up 3 finding(s) in <https://github.com/acme/payments/pull/42|acme/payments #42>
❗ Scan coverage was incomplete for <https://github.com/acme/payments/pull/42|acme/payments #42>: semgrep: partial-results (1)
```

Only configured events that apply to the scan are included. The PR link uses Slack's `<url|label>` syntax so each standalone event line renders with a clickable hyperlink.

**Custom template example:**
```json
"template": ":rotating_light: *{{repo}} PR #{{prNumber}}* - {{total}} finding(s): {{critical}} critical, {{high}} high"
```

You can use Slack's mrkdwn formatting in your template string.

**Schema:**
```json title="config/layne.json"
{
  "$global": {
    "notifications": {
      "slack": {
        "enabled":    true,
        "webhookUrl": "$SLACK_WEBHOOK_URL"
      }
    }
  }
}
```


---

## Examples

**Single global webhook for all repos:**
```json title="config/layne.json"
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

**Per-repo webhook with a custom message:**
```json title="config/layne.json"
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
        "template":   ":rotating_light: *Payment system alert - {{repo}} PR #{{prNumber}}*\n{{total}} finding(s): {{critical}} critical, {{high}} high, {{medium}} medium, {{low}} low"
      }
    }
  }
}
```

**Opt a specific repo out of global notifications:**
```json title="config/layne.json"
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

**Global Rocket.Chat + per-repo Slack stacked alongside it:**
```json title="config/layne.json"
{
  "$global": {
    "notifications": {
      "rocketchat": { "enabled": true, "webhookUrl": "$ROCKETCHAT_WEBHOOK_URL" }
    }
  },
  "acme/payments": {
    "notifications": {
      "slack": { "enabled": true, "webhookUrl": "$PAYMENTS_SLACK_WEBHOOK_URL" }
    }
  }
}
```

In this example, `acme/payments` sends to both Rocket.Chat (inherited from global) and Slack (added per-repo).


---

## Adding a new notifier

See [Extending Layne](extending.md#adding-a-new-notifier).
