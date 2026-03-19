# Notifiers

Layne can send a message to a chat platform when a scan finds new issues. Notifications fire after the GitHub Check Run is posted and are independent of it - a notification failure never affects the scan result.

Notifiers are configured under the `notifications` key in `config/layne.json`.


## Deduplication

Layne only notifies when the finding count **increases** compared to the previous scan for the same PR. If a developer pushes a follow-up commit that does not introduce new findings, no notification is sent. The previous count is stored in Redis with a 30-day TTL. A Redis read error is treated as a previous count of zero (fail open - the notification fires).


## Global vs per-repo

Notifications use per-notifier-key merging:

- A per-repo `rocketchat` block **replaces** the global `rocketchat` block.
- A per-repo `slack` block **stacks alongside** a global `rocketchat` block - both fire.
- A repo can opt out of a global notifier by setting `"enabled": false` for that key.
- If neither `$global` nor the repo defines a `notifications` block, no notifications are sent.

See [Configuration](./configuration.md#override-behaviour-by-key) for the full override behaviour table.


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
| `{{summary}}` | Pre-rendered summary line, e.g. `Found 2 issue(s): 1 high, 1 medium.` |

Omit `template` to use the default message format for that notifier.


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

**Default message:**
```
🦴 Good boy Layne dug up 3 finding(s) in https://github.com/acme/payments/pull/42
```

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

**Setup:** Create a Slack app, enable Incoming Webhooks, add a webhook for your channel, and copy the resulting `https://hooks.slack.com/services/...` URL.

**Default message:**
```
🦴 Good boy Layne dug up 3 finding(s) in <https://github.com/acme/payments/pull/42|acme/payments #42>
```

The PR link uses Slack's `<url|label>` syntax so it renders as a clickable hyperlink.

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
