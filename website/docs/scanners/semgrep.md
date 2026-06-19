# Semgrep

<div style={{textAlign: 'center'}}>
  <img src="/img/semgrep.png" alt="Semgrep" width="200" />
</div>

Semgrep is an open-source static analysis engine that matches code patterns against a library of security rules. It runs **locally inside the Layne worker container** - no code is sent to any external service.

Semgrep is enabled for all repos by default.


## What it detects

Semgrep scans for code-level vulnerabilities using rule-based pattern matching. With the default `--config auto` ruleset it covers a broad range of issues across most common languages: SQL injection, XSS, hardcoded credentials, insecure deserialization, path traversal, and more. You can narrow or expand coverage by pointing it at specific rulesets and you can develop your own custom rulesets.


## How Layne runs it

Layne runs Semgrep against only the files changed in the PR - not the entire repository. In [`diff_only` mode](../configuration.md#scan-mode), Semgrep receives projected copies of those files containing only the changed hunks plus surrounding context lines, with blank lines holding the positions of unchanged content. The command is assembled as:

```
semgrep scan <extraArgs> --json -- <absolute-file-paths...>
```

Arguments are passed via `execFile` - not through a shell - so shell injection through file paths or config values is not possible.

**Exit codes:** Semgrep exits `1` when findings are found. Layne treats this as a normal result and parses stdout, not as an error.

**Severity mapping:**

| Semgrep severity | Layne severity | GitHub annotation level | Blocks merge? |
|---|---|---|---|
| `ERROR` | `high` | `failure` | Yes |
| `WARNING` | `medium` | `warning` | No |
| `INFO` | `low` | `notice` | No |

Layne's reporter also handles `critical` severity (mapped to `failure`), but Semgrep itself does not emit `critical` - that level is used by other scanners such as Claude.


## Configuration

```json title="config/layne.json"
{
  "$global": {
    "semgrep": {
      "enabled": true,
      "extraArgs": ["--config", "auto"]
    }
  }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Set to `false` to skip Semgrep entirely for this repo |
| `extraArgs` | string[] | `["--config", "auto"]` | CLI flags passed verbatim between `semgrep scan` and `--json` |

**`extraArgs` replaces the default entirely.** If you set per-repo `extraArgs`, include everything you need - there is no merging with the global value.

:::warning paths.include and paths.exclude in rules are not effective
Semgrep rules support a `paths:` block to restrict which files a rule applies to. This does not work reliably with Layne. Because Layne passes an explicit list of file paths to Semgrep rather than a directory, Semgrep bypasses rule-level path filtering - `paths.include` and `paths.exclude` entries are silently ignored. This is a known issue. Avoid writing or relying on rules that use `paths:` filters when using Layne.
:::

### `--disable-nosem`

:::warning
By default, contributors can silence a Semgrep finding by adding `// nosemgrep` to the offending line **in their own PR**. Without `--disable-nosem`, a developer can suppress a genuine finding in the exact PR being reviewed - bypassing the security gate entirely.
:::

Add `--disable-nosem` to your global `extraArgs` to close this gap:

```json title="config/layne.json"
{
  "$global": {
    "semgrep": {
      "extraArgs": ["--config", "auto", "--disable-nosem"]
    }
  }
}
```

If you set per-repo `extraArgs`, carry `--disable-nosem` across as well - it does not merge with the global value. See [Finding Suppression](../finding-suppression.md) for the full picture, including the `// SECURITY:` replacement mechanism.


## Examples

**Use a specific ruleset instead of `auto`:**
```json title="config/layne.json"
{
  "acme/frontend": {
    "semgrep": {
      "extraArgs": ["--config", "p/owasp-top-ten", "--severity", "WARNING", "--disable-nosem"]
    }
  }
}
```

**Stack multiple rulesets:**
```json title="config/layne.json"
{
  "acme/backend": {
    "semgrep": {
      "extraArgs": ["--config", "auto", "--config", "p/python", "--disable-nosem"]
    }
  }
}
```

**Disable Semgrep for a repo:**
```json title="config/layne.json"
{
  "acme/internal-tool": {
    "semgrep": {
      "enabled": false
    }
  }
}
```
