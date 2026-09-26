# PR Comments

Layne can post a comment directly on the pull request when a scan finds security issues. The comment appears in the PR thread and is **updated in place** on each re-push - it does not accumulate new comments.

PR comments are disabled by default and must be opted in per repo or globally.


## Behaviour

- When blocking findings are present: Layne posts or updates a caution comment.
- When only non-blocking findings are present and coverage completed: Layne posts or updates a warning comment.
- When scanner or Git coverage is incomplete and no blocking finding exists: Layne posts or updates an incomplete warning, with any valid partial findings that were retained.
- When blocking findings and incomplete coverage coexist: `failure` takes precedence, so the comment uses the caution format. The Check Run summary still lists the coverage gap.
- When Spectre's file caps leave score-12-or-higher files unscanned: Layne posts or updates a failure comment with bounded file, score, signal, and overflow details. Findings from scanned files remain in the normal findings table. If no findings were retained, the comment contains only the caution and coverage details.
- When a subsequent push clears all findings and coverage completes: Layne updates the existing comment to show "scan passed". If there is no existing Layne comment, nothing is posted.

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

Incomplete (`neutral`) comments always use Layne's built-in coverage warning. `template` and `warningTemplate` do not override it. A blocking Spectre file-cap coverage section is appended to the normal failure comment; with no findings, Layne posts a built-in coverage-only caution.

### Global vs per-repo

Per-repo `comment` keys **merge** into the global block - set only what differs.

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

**Layne found 1 high, 1 medium issues in this PR.**

<details>
<summary>View 2 finding(s)</summary>

| Severity | Scanner | File | Rule | Description |
|---|---|---|---|---|
| 🟠 High | semgrep | [`src/app.js:42`](https://github.com/acme/payments/blob/abc123/src/app.js#L42) | python.lang.security.eval | Dangerous use of eval |
| 🟡 Medium | spectre | [`scripts/setup.sh:7`](https://github.com/acme/payments/blob/abc123/scripts/setup.sh#L7) | reverse-shell | Reverse shell detected |

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

**When coverage is incomplete and no findings were retained:**
```markdown
<!-- layne-security-scan -->
⚠️ **Layne - scan incomplete**

Layne could not analyze all changed content. Review the Check Run summary before merging.
```

When partial findings are available, the incomplete comment includes the same findings table under a warning that the results may be incomplete.

When high-risk Spectre overflow produces `failure`, the comment and Check Run summary list at most ten unscanned files with their routing scores and controlled signal names, followed by the number of additional omitted files. These entries describe a coverage gap and are not findings or inline annotations.


## Custom templates

Set `template` (for blocking findings) or `warningTemplate` (for non-blocking findings) to a Markdown string with `{{variable}}` placeholders. The available variables are a superset of the notifier variables - see [Notifiers - Template variables](notifiers.md#template-variables) for the base list, plus these two that are specific to PR comments:

| Placeholder | Value |
|---|---|
| `{{severitySummary}}` | Severity counts as a comma-separated string, e.g. `1 high, 2 medium` |
| `{{findings}}` | Pre-rendered findings table (Severity, Scanner, File with line, Rule, Description) with links to the exact line |

:::warning
Any custom template must include `<!-- layne-security-scan -->`. Layne searches the whole comment body for this marker when updating on re-pushes; placing it on the first line keeps it unobtrusive and easy to audit. Without it, every scan creates a new comment instead of updating the existing one.
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
