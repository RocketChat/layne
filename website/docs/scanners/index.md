# Scanners

Layne can run several scanners on every pull request. They execute in parallel - a slow scanner does not hold up the others.

| Scanner | What it detects | Runs where | Default |
|---|---|---|---|
| [Semgrep](semgrep.md) | Code vulnerabilities (SAST) | Locally - no data leaves your environment | Enabled |
| [Trufflehog](trufflehog.md) | Secrets and credentials | Locally - no data leaves your environment | Enabled |
| [Claude](claude.md) | Malicious intent / AI-powered SAST | Anthropic API - code is sent externally | Disabled |
| [Pi Agent](pi-agent.md) | Malicious intent / AI-powered SAST | Different AI providers are supported | Disabled |

Each scanner produces findings in the same shape, which Layne converts to GitHub Check Run annotations:

| Severity | GitHub annotation | Blocks merge? |
|---|---|---|
| `critical` / `high` | `failure` | Yes - when Layne is a required check |
| `medium` | `warning` | No |
| `low` / `info` | `notice` | No |

All three scanners only scan the files changed in the PR - not the entire repository.

---

Read on for scanner-specific details, configuration options, and examples:

- [Semgrep](semgrep.md) - rule-based SAST, `extraArgs`, ruleset selection
- [Trufflehog](trufflehog.md) - secret detection, batching, `--only-verified`
- [Claude](claude.md) - malicious intent, AI-powered SAST
- [Pi Agent](pi-agent.md) - malicious intent, AI-powered SAST

For how to suppress false positives, see [Finding Suppression](../finding-suppression.md).
