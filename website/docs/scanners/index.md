# Scanners

Layne can run several scanners on every pull request. They execute in parallel - a slow scanner does not hold up the others.

| Scanner | What it detects | Runs where | Default |
|---|---|---|---|
| [Semgrep](semgrep.md) | Code vulnerabilities (SAST) | Locally - no data leaves your environment | Enabled |
| [Trufflehog](trufflehog.md) | Secrets and credentials | Locally - no data leaves your environment | Enabled |
| [Claude](claude.md) | Malicious intent / AI-powered SAST | Anthropic API - code is sent externally | Disabled |
| [Spectre](spectre.md) | Malicious intent from bounded typed PR diffs | External AI provider API - diff and PR metadata are sent externally | Disabled |
| [Dep Doctor](dep-doctor.md) | Known vulnerabilities, abandoned and deprecated dependencies | Locally (OSV-Scanner) + npm/PyPI registry APIs | Disabled |

Each scanner produces findings in the same shape, which Layne converts to GitHub Check Run annotations:

| Severity | GitHub annotation | Blocks merge? |
|---|---|---|
| `critical` / `high` | `failure` | Yes - when Layne is a required check |
| `medium` | `warning` | No |
| `low` / `info` | `notice` | No |

Each adapter also returns a completion status:

| Outcome | Meaning |
|---|---|
| `complete` | The scanner finished all work selected by its configured scope, whether or not it found anything |
| `incomplete` | Some selected content could not be analyzed or the output could not be trusted |
| `disabled` | The scanner was intentionally disabled by configuration |

Valid findings from completed work are retained even if another batch is incomplete. Blocking findings still produce `failure`; without a blocking finding, incomplete coverage normally makes the Check Run `neutral` rather than claiming a clean pass. Spectre is stricter when its file caps leave score-12-or-higher files unscanned: that coverage condition produces `failure` without inventing a finding. A normal `disabled` result does not affect the conclusion.

When there is no applicable changed content, an adapter may return `complete` without running even if its configuration is disabled. Both outcomes mean there is no missing intended coverage for that scan.

Configured selection policies can intentionally exclude content. In particular, `maxFileSizeKb` exclusions do not make the file-oriented adapters incomplete; Spectre treats oversized selected files as an explicit coverage gap. Dep Doctor separately admits recognized lockfiles up to `maxLockfileSizeKb` and treats larger lockfiles as incomplete dependency coverage. See [Configuration - maxFileSizeKb](../configuration.md#maxfilesizekb).

That Spectre size accounting is applied after its adapter returns only when Spectre is enabled. A disabled Spectre result remains `disabled`, including when changed files exceed `maxFileSizeKb`.

Scanners analyze changed PR content, not an unconditional whole-repository checkout. The exact input differs by scanner and [scan mode](../configuration.md#scan-mode): Semgrep parses complete selected HEAD files and is post-filtered in `diff_only`, Trufflehog receives changed files or projected hunks, and Spectre receives the typed base-to-head diff restricted to eligible code-bearing files.

---

Read on for scanner-specific details, configuration options, and examples:

- [Semgrep](semgrep.md) - rule-based SAST, `extraArgs`, ruleset selection
- [Trufflehog](trufflehog.md) - secret detection, batching, `--only-verified`
- [Claude](claude.md) - malicious intent, AI-powered SAST
- [Spectre](spectre.md) - malicious intent, whole-PR and hunk-chunk analysis, multi-provider
- [Dep Doctor](dep-doctor.md) - known-vulnerability, abandoned, and deprecated package checks

For how to suppress false positives, see [Finding Suppression](../finding-suppression.md).
