# Spectre

<div style={{textAlign: 'center'}}>
  <img src="/img/spectre.png" alt="Spectre" width="160" />
</div>

Spectre is a malicious-intent scanner that makes a single direct LLM call per changed file. It looks for **reverse shells, backdoors, obfuscated payloads, credential exfiltration, supply-chain attacks, and covert execution** - confirmed hostile patterns with high confidence, not theoretical vulnerabilities.

Spectre replaced the previous Pi Agent scanner, and is built on top of Pi to leverage its multi-provider support. The key design principle is cost control: one LLM call per file, no agent sessions, no multi-turn conversations, no import following. This keeps spend predictable and low enough for a $50/month budget across dozens of active repositories.

Spectre **sends code to an external AI provider's API**. It is disabled by default and must be opted in per repo. A `provider` must be configured explicitly - omitting it disables Spectre even when `enabled: true` is set. The provider must also be configured with the correct credentials in the environment - see [Provider credentials](#provider-credentials) below.


## What it detects

Spectre looks specifically for confirmed malicious patterns with high confidence:

- Reverse shells and command-and-control callbacks
- Backdoors and authentication bypasses
- Credential and secret exfiltration
- Obfuscated payloads (base64/hex encoded, eval chains)
- Supply-chain attacks (postinstall hooks, URL dependencies with hostile execution, dependency confusion)
- Covert execution (dangerous dynamic execution where the surrounding logic is clearly hostile)

The built-in prompt instructs Spectre to omit anything it cannot validate with a verbatim evidence snippet, and to ignore style issues, bugs, and theoretical vulnerabilities.


## Data privacy

Source code leaves your environment when Spectre is enabled. Consider whether this is appropriate for repositories containing sensitive business logic, PII, or regulated data. The destination depends on the configured `provider` - code may be sent to Anthropic, OpenAI, Google, Amazon Bedrock, or another third-party API.

What is sent depends on the [scan mode](../configuration.md#scan-mode) configured for the repo:

- **`changed_files` mode (default):** The full content of every changed source file is sent to the provider.
- **`diff_only` mode:** Only the changed hunks with surrounding context are sent. This reduces both cost and the amount of code that leaves the environment.

Spectre never follows imports into unchanged files. Only files explicitly changed in the PR are considered.


## How Layne runs it

1. Files are filtered by the built-in skip list (binary files, images, stylesheets, minified files) and any `skipPaths`/`skipExtensions` configured for the repo.
2. Eligible files are sorted into three tiers by priority:
   - **Tier 1** - path-matched high-value files: `package.json`, lock files, `.github/workflows/`, `Dockerfile*`, `docker-compose*`, `.env*`. Always processed first; supply-chain attacks concentrate here.
   - **Tier 2** - keyword-promoted files: the full content of each remaining file is scanned for suspicious patterns. Files matching any pattern are promoted above ordinary files. Add repo-specific patterns via `boostPatterns`. The built-in pattern set covers:
     - Dynamic code execution: `eval(`, `new Function(`
     - Encoding/decode sinks: `atob(`, `String.fromCharCode(`
     - Shell execution: `require('child_process')`, `execSync(`, `spawnSync(`
     - Direct shell invocation: `/bin/sh`, `/bin/bash`, `/bin/zsh`, `/bin/dash`
     - TCP shell redirection: `/dev/tcp/`
     - Raw TCP: `net.Socket`
     - Cloud metadata endpoints: `169.254.169.254`, `metadata.google.internal`
     - npm lifecycle hooks: `"postinstall":`, `"preinstall":`, `"prepare":`
     - Remote fetch in shell/CI: `curl`/`wget` with an HTTP(S) URL
     - Dynamic imports with a non-literal argument: `import(`
   - **Tier 3** - everything else: fills remaining capacity after tiers 1 and 2.
3. The combined list is capped at `fileCap` (default: 20). Tiers fill capacity in order - a file with a suspicious keyword that would otherwise be position 28 in the diff gets scanned ahead of a benign file at position 3.
4. **Secondary batch:** any keyword-matched (tier 2) files that overflowed the primary cap are collected and scanned as an additional batch, capped at `secondaryFileCap` (default: 20). This means a PR with many suspicious files can scan up to 40 files total without ever spending LLM calls on ordinary files that matched no patterns. Set `secondaryFileCap: 0` to disable this and restore a hard 20-file ceiling.
5. Each file in the final list is scanned with a single LLM call. The prompt includes the file content (or diff in `diff_only` mode) and asks for a JSON response listing any findings with verbatim evidence snippets.
5. Findings with severity below `minSeverity` are dropped. Findings that lack an `evidence` field or have an empty evidence string are also silently dropped - the evidence snippet is required for location validation. For each surviving finding, Layne re-validates the evidence string against the actual file content before reporting it.
6. API errors are caught and logged without failing the scan.


## Configuration

```json
{
  "owner/repo": {
    "spectre": {
      "enabled": true,
      "provider": "anthropic",
      "model": "claude-haiku-4-5-20251001"
    }
  }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Must be `true` to enable Spectre scanning for this repo |
| `provider` | string | (none) | **Required.** AI provider to use. Omitting this disables Spectre even if `enabled: true`. Supported values: `anthropic`, `openai`, `google`, `mistral`, `amazon-bedrock` |
| `model` | string | `claude-haiku-4-5-20251001` | Model ID to use. Must be a valid model ID for the configured provider. **Bedrock uses provider-prefixed IDs** (e.g. `anthropic.claude-haiku-4-5-20251001-v1:0`) - the default `claude-haiku-4-5-20251001` will not resolve on Bedrock |
| `fileCap` | number | `20` | Maximum number of files to scan in the primary batch. Tier 1 files (manifests, lock files, CI configs) always consume capacity first |
| `secondaryFileCap` | number | `20` | Maximum number of additional keyword-matched files to scan beyond the primary cap. Set to `0` to disable and enforce a hard `fileCap` ceiling |
| `maxDiffLines` | number | `400` | Maximum lines of file content to send to the LLM per file. Longer files are truncated to this limit before the API call |
| `minSeverity` | string | `"high"` | Minimum severity to report. One of `"critical"`, `"high"`, `"medium"`, `"low"`, `"info"`. Findings below this threshold are dropped before annotation |
| `skipPaths` | string[] | `[]` | Glob patterns for paths to exclude. Supports `*` (single path segment) and `**` (any depth). Example: `["vendor/**", "test/**"]` |
| `skipExtensions` | string[] | `[]` | File extensions to exclude. Must start with `.`. Example: `[".test.ts", ".spec.js"]` |
| `concurrency` | number | `5` | Maximum number of files to scan in parallel per job |
| `prompt` | string | built-in | Custom analysis instructions. Replaces the default "what to detect" section of the system prompt. The JSON output format is always appended automatically - your prompt should only describe what to look for, not how to format the response |
| `boostPatterns` | string[] | `[]` | Additional regex patterns (as strings) added to the tier 2 keyword list. Files whose full content matches any pattern are prioritised within the cap ahead of tier 3 files. Invalid regex strings are silently ignored with a console warning - test patterns before deploying. See the Examples section for usage |

Spectre scanning is disabled by default to avoid unexpected API costs. Each repo must explicitly opt in with both `enabled: true` and a `provider`.


## Rule IDs

| Rule ID | Description |
|---|---|
| `reverse-shell` | Reverse shells, bind shells, or interactive stdio forwarding to a remote process |
| `credential-exfiltration` | Secrets, tokens, keys, cookies, or env vars sent to an external destination |
| `obfuscated-payload` | Encoded or constructed strings that decode into code, commands, or malicious URLs fed to an execution sink |
| `backdoor` | Hidden admin paths, secret trigger strings, kill switches, or covert remote command execution |
| `supply-chain-abuse` | Hostile install-time scripts, URL/git dependencies with suspicious execution, or dependency confusion with concrete hostile behavior |
| `covert-execution` | Dangerous dynamic execution where the surrounding logic is clearly hostile and does not fit a more specific category above |


## Cost

Spectre makes one API call per scanned file. Total cost per PR = *(files scanned)* × *(tokens per file)* × *(provider rate)*.

The `fileCap` (default: 20) is the primary cost control, and `secondaryFileCap` (default: 20) controls how many additional keyword-matched overflow files are scanned. In the worst case - a PR with 40+ files that all contain suspicious patterns - Spectre scans up to 40 files total. PRs with no keyword-matching files stay at the 20-file ceiling. Set `secondaryFileCap: 0` to enforce a hard cap of `fileCap` regardless. Combined with `diff_only` mode, which reduces tokens per file, a typical PR costs a few cents at most with a small model like `claude-haiku-4-5-20251001`.

Amazon Bedrock is an attractive option for cost-sensitive deployments - it provides access to multiple model families (Claude, Llama, Mistral) under your own AWS billing, often at rates below the direct provider API. See [Provider credentials](#provider-credentials) below.

The most effective cost control is the `workflow_run` or `workflow_job` trigger, which defers scanning until after CI passes. PRs that fail CI quickly are not scanned at all. See [Configuration - Trigger](../configuration.md#trigger) for details.


## Provider credentials

Each provider reads credentials from environment variables. The worker logs a warning and skips Spectre if credentials are missing rather than failing the scan.

| Provider value | Required environment variable(s) |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `google` | `GEMINI_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `amazon-bedrock` | **Option A (API key):** `AWS_BEARER_TOKEN_BEDROCK` + `AWS_REGION` - simplest, no IAM user needed<br/>**Option B (IAM):** `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `AWS_REGION`<br/>**Option C (profile/role):** set `AWS_PROFILE` and let the SDK resolve credentials from `~/.aws/credentials` or an EC2 instance role |

Add the relevant variable(s) to your `.env` file and to your production secrets store.


## Examples

**Enable Spectre with Anthropic (fast, cheap model):**
```json
{
  "acme/backend": {
    "spectre": {
      "enabled": true,
      "provider": "anthropic",
      "model": "claude-haiku-4-5-20251001"
    }
  }
}
```

**Use Amazon Bedrock:**
```json
{
  "acme/backend": {
    "spectre": {
      "enabled": true,
      "provider": "amazon-bedrock",
      "model": "anthropic.claude-haiku-4-5-20251001-v1:0"
    }
  }
}
```

Bedrock model IDs use a provider-prefixed format. Cross-region inference profile variants are also available (`us.anthropic.claude-haiku-4-5-20251001-v1`, `eu.anthropic.claude-haiku-4-5-20251001-v1`). The region defaults to `us-east-1` unless `AWS_REGION` is set.

**Use OpenAI:**
```json
{
  "acme/backend": {
    "spectre": {
      "enabled": true,
      "provider": "openai",
      "model": "gpt-4o-mini"
    }
  }
}
```

**Lower the file cap for a small, focused service:**
```json
{
  "acme/auth-service": {
    "spectre": {
      "enabled": true,
      "provider": "anthropic",
      "model": "claude-haiku-4-5-20251001",
      "fileCap": 10
    }
  }
}
```

**Skip test files and vendored code:**
```json
{
  "acme/backend": {
    "spectre": {
      "enabled": true,
      "provider": "anthropic",
      "model": "claude-haiku-4-5-20251001",
      "skipPaths": ["vendor/**", "**/__tests__/**", "**/*.test.ts"],
      "skipExtensions": [".spec.js", ".spec.ts"]
    }
  }
}
```

**Report medium-severity findings too:**
```json
{
  "acme/backend": {
    "spectre": {
      "enabled": true,
      "provider": "anthropic",
      "model": "claude-haiku-4-5-20251001",
      "minSeverity": "medium"
    }
  }
}
```

**Use a domain-specific prompt for a monorepo with known threat patterns:**
```json
{
  "acme/backend": {
    "spectre": {
      "enabled": true,
      "provider": "anthropic",
      "model": "claude-haiku-4-5-20251001",
      "prompt": "You are a security reviewer for a Node.js payment service. Detect malicious intent only: reverse shells, backdoors, credential exfiltration, obfuscated payloads, and supply-chain attacks.\n\nPay extra attention to:\n- package.json lifecycle scripts - primary supply-chain vector\n- Any code that touches process.env and makes outbound network calls\n- Calls to cloud metadata endpoints (169.254.169.254)\n\nReport ONLY confirmed malicious patterns with high confidence."
    }
  }
}
```

The JSON output format is appended automatically - your prompt only needs to describe the threat model and context, not the response structure.

**Add repo-specific keyword patterns to promote suspicious files (Python service example):**
```json
{
  "acme/data-pipeline": {
    "spectre": {
      "enabled": true,
      "provider": "anthropic",
      "model": "claude-haiku-4-5-20251001",
      "boostPatterns": [
        "\\bsubprocess\\.(?:run|call|Popen)\\b",
        "\\bos\\.system\\b",
        "\\bpyc_compile\\b"
      ]
    }
  }
}
```

Each entry is a regex pattern string. Backslashes must be double-escaped in JSON (`\\b` for a word boundary, `\\.` for a literal dot). Files whose full content matches any pattern are promoted to tier 2 and scanned ahead of ordinary files when the cap is applied.

**Defer Spectre until after CI passes (recommended for cost control):**
```json
{
  "acme/backend": {
    "spectre": {
      "enabled": true,
      "provider": "anthropic",
      "model": "claude-haiku-4-5-20251001"
    },
    "trigger": {
      "on": "workflow_run",
      "workflow": "CI"
    }
  }
}
```

**Use `diff_only` mode to reduce tokens and cost:**
```json
{
  "acme/backend": {
    "mode": "diff_only",
    "contextLines": 8,
    "spectre": {
      "enabled": true,
      "provider": "anthropic",
      "model": "claude-haiku-4-5-20251001"
    }
  }
}
```
