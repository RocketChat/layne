# Pi Agent

The Pi Agent scanner uses an autonomous AI agent to detect **malicious intent** in changed code - reverse shells, backdoors, obfuscated payloads, credential exfiltration, and supply-chain attacks.

Pi Agent **sends code to an external AI provider's API**. It is disabled by default and must be opted in per repo. A `provider` must be configured explicitly - omitting it disables Pi Agent even when `enabled: true` is set.

:::warning Experimental
Pi Agent is an experimental scanner. It may produce inconsistent results, miss findings, or behave unexpectedly across runs. Do not rely on it as your sole security gate.
:::


## What it detects

Pi Agent looks specifically for confirmed malicious patterns with high confidence:

- Reverse shells and command-and-control callbacks
- Backdoors and authentication bypasses
- Credential and secret exfiltration
- Obfuscated payloads (base64/hex encoded, eval chains)
- Supply-chain attacks (postinstall hooks, URL dependencies with hostile execution, dependency confusion)
- Covert execution (dangerous dynamic execution where the surrounding logic is clearly hostile)

Pi Agent does **not** report style issues, bugs, or theoretical vulnerabilities. The built-in prompt instructs it to omit any finding it cannot validate with a verbatim evidence snippet from the file.


## Data privacy

Source code leaves your environment when Pi Agent is enabled. Consider whether this is appropriate for repositories containing sensitive business logic, PII, or regulated data. The destination depends on the configured `provider` - code may be sent to Anthropic, OpenAI, Google, or another third-party API.

What is sent depends on the [scan mode](../configuration.md#scan-mode) configured for the repo:

- **`changed_files` mode (default):** The full content of every changed source file is available for the agent to read on demand. Binary files are skipped.
- **`diff_only` mode:** The workspace contains projected copies of each file with only the changed hunks and surrounding context. The agent reads these projected files.


## How Layne runs it

1. A confined agent session is created with read-only tools (`read`, `grep`, `find`, `ls`) scoped strictly to the scan workspace - the agent cannot access paths outside it.
2. The agent receives the list of changed files with their changed line ranges as context.
3. The agent autonomously investigates: it reads files in full, searches for patterns with grep, follows imports, and traverses related code. Changed line ranges are provided as anchoring context, not as a hard boundary.
4. For each confirmed finding, the agent calls `report_finding` with a verbatim evidence snippet. Line numbers are hints only - Layne re-validates each finding against the evidence string before reporting it.
5. The session runs until the agent finishes or the timeout is reached. If the timeout fires, any findings accumulated so far are returned as partial results.
6. API errors are caught and logged without failing the scan.


## Non-determinism

Because the agent drives its own investigation path, the same code may produce findings with different evidence, line numbers, or even `ruleId` values across runs. Finding IDs (`LAYNE-xxxxxxxxxxxxxxxx`) are derived from the finding content - if a finding shifts, its ID changes and any exception approval tied to it will no longer match. Use exception approvals for Pi Agent findings with this in mind.


## Configuration

```json
{
  "owner/repo": {
    "piAgent": {
      "enabled": true,
      "provider": "anthropic",
      "model": "claude-opus-4-6"
    }
  }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Must be `true` to enable Pi Agent scanning for this repo |
| `provider` | string | (none) | **Required.** AI provider to use. Omitting this disables Pi Agent even if `enabled: true`. Supported values: `anthropic`, `openai`, `azure-openai-responses`, `google`, `google-gemini-cli`, `google-vertex`, `mistral`, `amazon-bedrock` |
| `model` | string | `claude-opus-4-6` | Model ID to use. Must be a valid model ID for the configured provider |
| `thinkingLevel` | string | `"medium"` | Depth of reasoning: `"low"`, `"medium"`, or `"high"`. `"high"` enables extended thinking |
| `timeoutMinutes` | number | `3` | Hard timeout for the agent session in minutes. Partial findings are returned if the timeout fires |
| `prompt` | string | built-in | Custom system prompt. Replaces the default prompt entirely |

Pi Agent scanning is disabled by default to avoid unexpected API costs. Each repo must explicitly opt in with both `enabled: true` and a `provider`.


## Rule IDs

Pi Agent findings use the `pi_agent/` prefix. The valid rule IDs are:

| Rule ID | Description |
|---|---|
| `pi_agent/reverse-shell` | Reverse shells, bind shells, or interactive stdio forwarding to a remote process |
| `pi_agent/credential-exfiltration` | Secrets, tokens, keys, cookies, or env vars sent to an external destination |
| `pi_agent/obfuscated-payload` | Encoded or constructed strings that decode into code, commands, or malicious URLs fed to an execution sink |
| `pi_agent/backdoor` | Hidden admin paths, secret trigger strings, kill switches, or covert remote command execution |
| `pi_agent/supply-chain-abuse` | Hostile install-time scripts, URL/git dependencies with suspicious execution, or dependency confusion with concrete hostile behavior |
| `pi_agent/covert-execution` | Dangerous dynamic execution where the surrounding logic is clearly hostile and does not fit a more specific category above |


## Cost

Pi Agent makes AI API calls charged per token - rates depend on the configured provider and model. When using `provider: "anthropic"`, the default model `claude-opus-4-6` is more expensive than the Claude scanner's default of `claude-haiku-4-5-20251001`. Setting `thinkingLevel` to `"high"` enables extended thinking and increases cost further.

The most effective cost control is the `workflow_run` or `workflow_job` trigger, which defers scanning until after CI passes. PRs that fail CI quickly are not scanned at all. See [Configuration - Trigger](../configuration.md#trigger) for details.

Use `thinkingLevel: "low"` for fast, cheap scans on low-risk repositories. Use `"high"` when you need deeper analysis of obfuscated or complex code.


## Pi Agent vs Claude scanner

Both scanners detect malicious intent. The difference is in how they investigate:

| | Claude | Pi Agent |
|---|---|---|
| Approach | Single batch API call | Full agent session with file tools |
| Can follow imports | No | Yes |
| Can search across files | No | Yes |
| Deterministic | Yes | No |
| Default model | Haiku (cheap) | Opus (expensive) |
| Timeout | No (single call) | Yes (default 3 min) |

Use Pi Agent when deeper cross-file investigation is valuable and the cost and non-determinism tradeoffs are acceptable. Use Claude when you want faster, cheaper, deterministic scanning with a simpler configuration surface.


## Examples

**Enable Pi Agent with Anthropic:**
```json
{
  "acme/backend": {
    "piAgent": {
      "enabled": true,
      "provider": "anthropic",
      "model": "claude-opus-4-6"
    }
  }
}
```

**Use OpenAI instead:**
```json
{
  "acme/backend": {
    "piAgent": {
      "enabled": true,
      "provider": "openai",
      "model": "gpt-4o"
    }
  }
}
```

**Use extended thinking for highly obfuscated code:**
```json
{
  "acme/backend": {
    "piAgent": {
      "enabled": true,
      "provider": "anthropic",
      "model": "claude-opus-4-6",
      "thinkingLevel": "high",
      "timeoutMinutes": 10
    }
  }
}
```

**Use a custom system prompt for domain-specific analysis:**
```json
{
  "acme/payments": {
    "piAgent": {
      "enabled": true,
      "provider": "anthropic",
      "model": "claude-opus-4-6",
      "prompt": "You are a security reviewer specializing in payment systems. Investigate the provided files for malicious intent: reverse shells, backdoors, credential exfiltration, and supply-chain attacks. Pay extra attention to anything that could exfiltrate card data or PII. Use the read, grep, find, and ls tools to follow imports and trace suspicious patterns. Report ONLY confirmed malicious patterns with high confidence. For each finding call report_finding with exact verbatim evidence."
    }
  }
}
```

**Defer Pi Agent until after CI passes (recommended for cost control):**
```json
{
  "acme/backend": {
    "piAgent": {
      "enabled": true,
      "provider": "anthropic",
      "model": "claude-opus-4-6"
    },
    "trigger": {
      "on": "workflow_run",
      "workflow": "CI"
    }
  }
}
```
