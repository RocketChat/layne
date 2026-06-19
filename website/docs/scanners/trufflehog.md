# Trufflehog

<div style={{textAlign: 'center'}}>
  <img src="/img/trufflehog.png" alt="Trufflehog" width="200" />
</div>

Trufflehog is an open-source secret scanning tool that detects credentials, API keys, tokens, and other sensitive material committed to source code. It runs **locally inside the Layne worker container** - no code is sent to any external service.

Trufflehog is enabled for all repos by default.


## What it detects

Trufflehog uses detector plugins for hundreds of secret types: AWS access keys, GitHub tokens, Stripe keys, database connection strings, private keys, and many more. It can optionally verify detected secrets against their respective APIs to confirm they are live (see `--only-verified` below).

Trufflehog does not detect code vulnerabilities (use Semgrep for that) and does not reason about intent (use Claude for that).


## How Layne runs it

Layne runs Trufflehog against only the files changed in the PR - not the entire repository. In [`diff_only` mode](../configuration.md#scan-mode), Trufflehog receives projected copies of those files containing only the changed hunks plus surrounding context lines. Secrets that exist exclusively in unchanged portions of a changed file will not be reported in that mode. The command is assembled as:

```
trufflehog filesystem --json --no-update <extraArgs> -- <absolute-file-paths...>
```

`--no-update` suppresses the version-check network call on every run.

Arguments are passed via `execFile` - not through a shell - so shell injection through file paths or config values is not possible.

**Batching:** To stay under the OS `ARG_MAX` limit, files are processed in batches of 200. On most PRs this is invisible; on large monorepo PRs with many changed files, you will see batch progress in the logs when `DEBUG_MODE=true`.

**Exit codes:** Trufflehog exits `183` when secrets are found. Layne treats this as a normal result and parses stdout, not as an error.

**Output format:** Trufflehog emits newline-delimited JSON - one result object per line.

**Severity:** All Trufflehog findings are reported as `high` severity, which maps to a `failure` annotation in the GitHub Check Run and blocks merge when branch protection is enabled.


## Configuration

```json title="config/layne.json"
{
  "$global": {
    "trufflehog": {
      "enabled": true,
      "extraArgs": ["--only-verified"]
    }
  }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Set to `false` to skip Trufflehog entirely for this repo |
| `extraArgs` | string[] | `[]` | CLI flags passed verbatim after `--no-update` and before `--` |

**`extraArgs` replaces the default entirely.** The default is an empty array - no extra args. If you override it, you take full control of what is passed.


## Reducing noise with `--only-verified`

By default Trufflehog reports all detected secrets, including unverified ones (patterns that look like secrets but may be test data, placeholders, or false positives). Passing `--only-verified` tells Trufflehog to make a live API call to confirm each detected credential is real before reporting it.

This significantly reduces false positives but adds latency and requires outbound network access from the worker container. It is the recommended setting for most repos:

```json title="config/layne.json"
{
  "$global": {
    "trufflehog": {
      "extraArgs": ["--only-verified"]
    }
  }
}
```

:::tip
If your worker runs in a network-restricted environment, omit `--only-verified` and expect some false positives. You can also use `--exclude-detectors` to suppress specific noisy detectors per repo.
:::


## Examples

**Only report verified (live) secrets:**
```json title="config/layne.json"
{
  "acme/scripts": {
    "trufflehog": {
      "extraArgs": ["--only-verified"]
    }
  }
}
```

**Exclude noisy detectors for a specific repo:**
```json title="config/layne.json"
{
  "acme/monorepo": {
    "trufflehog": {
      "extraArgs": ["--only-verified", "--exclude-detectors", "GitHub,Slack"]
    }
  }
}
```

**Disable Trufflehog for a repo:**
```json title="config/layne.json"
{
  "acme/internal-tool": {
    "trufflehog": {
      "enabled": false
    }
  }
}
```
