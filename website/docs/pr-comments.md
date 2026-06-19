# PR Comments

Layne can post a comment directly on the pull request when a scan finds security issues. The comment appears in the PR thread and is **updated in place** on each re-push - it does not accumulate new comments.

PR comments are disabled by default and must be opted in per repo or globally.


## Behaviour

- When a scan finds issues: Layne posts (or updates) a comment with the finding summary.
- When a subsequent push clears all findings: Layne updates the existing comment to show "scan passed".
- When a scan passes and there was no prior failure comment: nothing is posted.

This means the comment only appears when there is something worth flagging, and it self-resolves visually when the developer fixes the issues.


## Configuration

```json title="config/layne.json"
{
  "$global": {
    "comment": {
      "enabled": false
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
| `template` | string \| null | `null` | Custom Markdown template for failure comments (blocking findings). Omit for the default format |
| `warningTemplate` | string \| null | `null` | Custom Markdown template for warning comments (non-blocking findings). Omit for the default format |

### Global vs per-repo

Per-repo `comment` keys **merge** into the global block - set only what differs. This is the one exception to the usual full-replacement behavior for top-level blocks.

To disable comments for a specific repo when they are globally enabled:
```json title="config/layne.json"
{
  "$global": {
    "comment": { "enabled": true }
  },
  "acme/low-signal-repo": {
    "comment": { "enabled": false }
  }
}
```


## Default format

**When blocking findings are present (`template`):**

```markdown
<!-- layne-security-scan -->

> [!CAUTION]
> These are security findings reported by the security scanners configured in Layne. Findings may contain false positives - review them and fix what makes sense. If you believe a finding is not valid, contact the security team.

**1 high, 2 medium**

<details>
<summary>View 3 finding(s)</summary>

| Severity | Scanner | File | Line | Rule | Description |
|---|---|---|---|---|---|
| 🟠 High | semgrep | [`src/app.js`](https://github.com/acme/payments/blob/abc123/src/app.js#L42) | [42](...) | python.lang.security.eval | Dangerous use of eval |
| 🟡 Medium | spectre | [`scripts/setup.sh`](https://github.com/acme/payments/blob/abc123/scripts/setup.sh#L7) | [7](...) | reverse-shell | Reverse shell detected |

</details>
```

**When non-blocking findings are present (`warningTemplate`):**

Same structure but uses `[!WARNING]` instead of `[!CAUTION]`, and omits the contact-the-security-team sentence.

**After a clean push:**
```markdown
<!-- layne-security-scan -->
✅ **Layne - scan passed**

No security issues found on latest push.
```


## Custom templates

Set `template` (for blocking findings) or `warningTemplate` (for non-blocking findings) to a Markdown string with `{{variable}}` placeholders. The available variables are a superset of the notifier variables - see [Notifiers - Template variables](notifiers.md#template-variables) for the base list, plus these two that are specific to PR comments:

| Placeholder | Value |
|---|---|
| `{{severitySummary}}` | Severity counts as a comma-separated string, e.g. `1 high, 2 medium` |
| `{{findings}}` | Pre-rendered findings table (Severity, Scanner, File, Line, Rule, Description) with links to the exact line in the file |

:::warning
Any custom template must include `<!-- layne-security-scan -->` as its **first line**. Layne uses this marker to find and update the existing comment on re-pushes. Without it, every scan creates a new comment instead of updating the existing one.
:::

Example:
```json title="config/layne.json"
{
  "acme/payments": {
    "comment": {
      "enabled": true,
      "template": "<!-- layne-security-scan -->\n## Security findings for {{repo}} PR #{{prNumber}}\n\n{{severitySummary}}\n\n{{findings}}"
    }
  }
}
```
