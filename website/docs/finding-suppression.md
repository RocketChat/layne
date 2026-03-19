# Finding Suppression

Semgrep supports `// nosemgrep` inline comments for silencing individual findings. While useful during development, they create a security gap: a contributor could add `// nosemgrep` to a line in their own PR and silently bypass the security gate in the exact PR where the finding appears.

This page explains how to close that gap with `--disable-nosem` and what the recommended suppression replacement looks like.


## Why `// nosemgrep` is a problem

:::warning
Without `--disable-nosem`, a developer can suppress a genuine Semgrep finding in the same PR being reviewed - bypassing the security gate at the moment it matters most.
:::

The fix is to add `--disable-nosem` to `extraArgs` in your global config or per repo. See [Semgrep - `--disable-nosem`](./scanners/semgrep.md#--disable-nosem) for the config snippet.

The replacement for `// nosemgrep` is a `// SECURITY:` comment that is **tamper-proof by design**.


## The replacement: `// SECURITY: <reason>`

Place a comment on the **same line** as the flagged code, or on the **line immediately above** it:

```js title="example.js"
// SECURITY: This eval call only runs trusted internal templates, never user input.
eval(internalTemplate);

const query = `SELECT * FROM users WHERE id = ${id}`; // SECURITY: id is always cast to integer by the ORM layer.
```

```yaml title="config.yml"
# SECURITY: This token is intentionally committed - it is a public read-only CI token with no write access.
GITHUB_TOKEN: ghp_...
```

The comment must include a non-empty justification after the colon. `// SECURITY:` with nothing after it is invalid.


## The tamper-proof guarantee

The suppressor reads each file at the **merge-base SHA** of the PR (the three-dot diff base) via `git show`. A `// SECURITY:` comment introduced in the **current PR** is not present at the merge base - so it has no effect. The comment must have been reviewed, approved, and merged in a **previous PR** before it suppresses anything.

This means a contributor cannot self-approve a finding by adding the suppression comment in their own PR.

The suppressor runs in the worker after the scanners return findings and before findings are converted to GitHub annotations. A suppressed finding is removed from the list entirely and never appears in the Check Run.


## Syntax rules

- Comment markers: `//` (JS/TS/Go/Java/C…) or `#` (YAML/shell/Python/Ruby…)
- The word `SECURITY` must be followed by a colon and at least one non-whitespace character: `// SECURITY: reason` ✓, `// SECURITY:` ✗
- Placement: same line as the finding, or the line immediately above


## Workflow

:::tip
Always submit suppression comments in a **separate PR** - never in the same PR that introduced the finding.
:::

1. Review the Semgrep finding. Confirm it is a genuine false positive.
2. Add `// SECURITY: <justification>` explaining why the pattern is safe here.
3. Submit a **separate PR** for the suppression comment. Have it reviewed and merged.
4. From that point forward, any PR that triggers the same finding on that line will have it suppressed automatically.


## Keeping `--disable-nosem` when overriding `extraArgs`

:::warning
`extraArgs` fully replaces the default - it does not extend it. If you set per-repo `extraArgs` without including `--disable-nosem`, the flag will be absent for that repo and contributors will be able to use `// nosemgrep` again.
:::

Always carry it across:

```json title="config/layne.json"
{
  "owner/repo": {
    "semgrep": {
      "extraArgs": ["--config", "p/owasp-top-ten", "--severity", "ERROR", "--disable-nosem"]
    }
  }
}
```
