# Scanners

Layne can run several scanners on every pull request. They execute in parallel - a slow scanner does not hold up the others.

| Scanner | What it detects | Runs where | Default |
|---|---|---|---|
| [Semgrep](semgrep.md) | Code vulnerabilities (SAST) | Locally - no data leaves your environment | Enabled |
| [Trufflehog](trufflehog.md) | Secrets and credentials | Locally - no data leaves your environment | Enabled |
| [Claude](claude.md) | Malicious intent / AI-powered SAST | Anthropic API - code is sent externally | Disabled |
| [Spectre](spectre.md) | Malicious intent (single LLM call per file) | External AI provider API - code is sent externally | Disabled |
| [Dep Doctor](dep-doctor.md) | CVEs, abandoned and deprecated dependencies | Locally (OSV-Scanner) + npm/PyPI registry APIs | Disabled |

Each scanner produces findings in the same shape, which Layne converts to GitHub Check Run annotations:

| Severity | GitHub annotation | Blocks merge? |
|---|---|---|
| `critical` / `high` | `failure` | Yes - when Layne is a required check |
| `medium` | `warning` | No |
| `low` / `info` | `notice` | No |

All scanners only scan the files changed in the PR - not the entire repository.

---

Read on for scanner-specific details, configuration options, and examples:

- [Semgrep](semgrep.md) - rule-based SAST, `extraArgs`, ruleset selection
- [Trufflehog](trufflehog.md) - secret detection, batching, `--only-verified`
- [Claude](claude.md) - malicious intent, AI-powered SAST
- [Spectre](spectre.md) - malicious intent, single LLM call per file, multi-provider
- [Dep Doctor](dep-doctor.md) - CVE detection, abandoned and deprecated package checks

For how to suppress false positives, see [Finding Suppression](../finding-suppression.md).
