# Spectre

<div style={{textAlign: 'center'}}>
  <img src="/img/spectre.png" alt="Spectre" width="160" />
</div>

Spectre is a bounded, non-agentic malicious-intent scanner. It analyzes a typed base-to-head unified diff and looks for **reverse shells, backdoors, obfuscated payloads, credential exfiltration, supply-chain attacks, and covert execution**. It reports confirmed hostile behavior with exact evidence, not general bugs or theoretical vulnerabilities.

Spectre is disabled by default. Enabling it sends changed source data and bounded pull request metadata to the configured external AI provider.

## Analysis model

Spectre no longer sends a HEAD-only snippet or unconditionally makes one call per file. Its provider-neutral core receives an in-memory typed diff, selected file paths, untrusted PR metadata, configuration, a governor, and a transport. Production uses the Pi AI transport; the deterministic simulator and manual evaluators use separate transports without changing the core response contract.

For each scan, Spectre:

1. Filters changed regular files to code-bearing inputs, then extracts bounded, deterministic routing signals and prioritizes eligible files by execution surface and compound behavior. These signals cannot create findings.
2. Builds a typed base-to-head unified diff containing file status and modes, old/new paths, hunk coordinates, additions, deletions, and unchanged context. `contextLines` controls the Git diff context for Spectre in both Layne scan modes.
3. Adds only the PR title, body, and author. These fields are explicitly marked untrusted and bounded to 512, 4,096, and 128 UTF-8 bytes respectively. The body is further limited to one fifth of the request input budget. Metadata cannot independently justify a finding.
4. Uses one whole-PR request when at most ten selected files are representable and the complete bounded diff fits both `maxInputBytes` and `maxDiffLines`. This preserves the response contract of up to three findings per supplied file.
5. When the whole PR does not fit, groups up to ten directly related changed files such as a lifecycle manifest and its script before falling back to file, hunk, source-line, and overlong-line splits. A related group that cannot fit is recorded as an incomplete context gap. Prompt-flooded files reserve an early request for their tail.
6. Applies `maxCallsPerFile` and `maxCallsPerPullRequest`. Content omitted by file, size, input, or call limits is never presented as complete coverage.
7. Forces one schema-constrained `report_findings` tool call with an allowed rule ID, severity, exact chunk file, message, and evidence. Layne still validates every field locally.
8. Grounds evidence verbatim against HEAD and changed lines. Invalid chunk output or ungrounded evidence receives at most one targeted retry per affected chunk, bounded by `maxRepairCallsPerPullRequest`. Evidence repair cannot change the candidate's file, rule, severity, or message.

The core is stateless and does not run tools, follow imports, browse a repository, or start an agent session.

## File selection

Spectre first removes formats outside its malicious-code scope. Binary, media, archive, compiled, generated TypeScript declaration, minified CSS, and ordinary prose files are skipped before size accounting, scoring, file caps, or provider requests. Built-in prose exclusions are `.md`, `.markdown`, `.txt`, `.rst`, `.adoc`, and `.asciidoc`, including agent-instruction Markdown such as `AGENTS.md` and `SKILL.md`. Known code-bearing text names remain eligible: `CMakeLists.txt`, `requirements*.txt`, and `constraints*.txt`. `.mdx` remains eligible as executable source, and a prose-suffixed file with executable Git mode remains eligible. These intentional exclusions increment the skipped counter and do not make coverage incomplete. Built-in exclusions cannot be opted out through repository configuration; `skipPaths` and `skipExtensions` can only narrow eligibility further.

Eligible files are scored before request planning. Path roles prioritize manifests, lockfiles, CI workflows, registry configuration, Dockerfiles, startup/persistence files, and automatic execution surfaces such as `build.rs`, `setup.py`, executable `.pth`, `binding.gyp`, and GYP includes. Content signals cover lifecycle hooks, workflow trust crossings, registry redirection, process/network/secret access, network plus process or dynamic execution, startup persistence, dynamic or encoded execution, covert child processes, prompt flooding, and source files whose content conflicts with their extension. Secret routing requires explicit environment/secret syntax, browser credential access, reads from known credential files, or a secret-shaped shell reference; bare platform words such as `AWS` do not count as secret access.

`astSignals.mode` optionally augments this lexical routing with bounded structural analysis for JavaScript, TypeScript, TSX, Python, and Go. `off` preserves lexical routing exactly. `shadow` computes structural routing and diagnostics but never changes selected files or coverage. `enabled` uses the union of lexical and changed-span structural signals. Primitive structural facts outside added lines are ignored; changed compound sink facts can promote a file. Parser, worker, or deadline failures fall back to lexical routing, while cancellation of the parent scan still propagates. Structural signals remain non-evidentiary and never create findings.

Signals are stronger when they form a compound chain such as network plus process execution, automatic execution plus network/process behavior, or sensitive data plus an HTTP, WebSocket, DNS, mail, browser, or cloud-upload sink. Encoding coverage includes base64, hex, compression, PowerShell encoded commands, and computed dynamic execution. Related changed files are co-selected when package lifecycle scripts, Python build backends, Dockerfiles, CMake files, CI workflows, GYP commands, local actions, or sourced shell scripts reference them. Relations are expanded from primary and high-risk candidates so a risk-selected execution surface can bring along its helper. Signals contain only controlled names and relation keys; they are non-evidentiary routing context and never become findings by themselves.

The primary selection is bounded by `fileCap`. Related or risk-scored overflow can use up to `secondaryFileCap` additional slots. If eligible files with a routing score of at least `12` remain unselected after both caps are full, Layne records `high-risk-file-cap-exceeded` and fails the Check Run. Routing scores still cannot create findings or annotations; the failure reports missing high-risk coverage instead. Active code-bearing text formats such as ordinary CSS, SVG, minified JavaScript, and MDX are not broadly excluded by the built-in filter.

## Data and credentials

Production provider requests contain the system prompt, bounded PR title/body/author, selected eligible paths and Git metadata, and their typed diff hunks with added, removed, and context lines. Excluded prose is not sent. Spectre does not send unchanged files or follow imports. This behavior is independent of `mode`; unlike file-oriented CLI scanners, Spectre uses the canonical unified diff in both `changed_files` and `diff_only` mode.

Review provider retention, region, training, and contractual controls before enabling Spectre for proprietary, regulated, or personal data. Provider credentials grant the worker the ability to submit this source data and incur model charges. Scope and rotate them accordingly.

| Provider value | Required environment variable(s) |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `google` | `GEMINI_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `amazon-bedrock` | `AWS_REGION` or `AWS_DEFAULT_REGION`, plus credentials resolved by the standard AWS credential chain. This can include `AWS_BEARER_TOKEN_BEDROCK`, static IAM credentials, a profile, or an instance/task role. |

Missing credentials, an invalid provider/model, or an unavailable provider produces an **incomplete** result rather than a clean pass.

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

| Key | Type | Default | Hard maximum | Description |
|---|---|---:|---:|---|
| `enabled` | boolean | `false` | n/a | Enables Spectre for the repository |
| `provider` | string | none | n/a | Required when enabled: `anthropic`, `openai`, `google`, `mistral`, or `amazon-bedrock` |
| `model` | string | `claude-haiku-4-5-20251001` | n/a | Provider-specific model ID. Bedrock model IDs are provider-prefixed |
| `fileCap` | integer | `20` | `30` | Primary selected-file limit after deterministic risk scoring. High-risk overflow after both caps is blocking |
| `secondaryFileCap` | integer | `20` | `50` | Additional related or risk-scored files; `0` disables secondary selection. High-risk overflow after this cap is blocking |
| `maxDiffLines` | integer | `400` | `1000` | Maximum typed diff lines in one request chunk |
| `maxInputBytes` | integer | `65536` | `65536` | Maximum UTF-8 bytes in one request's user payload, including metadata and the diff envelope but excluding the system prompt |
| `maxOutputTokens` | integer | `1200` | `2000` | Provider generation limit. Reaching it makes the response invalid and coverage incomplete |
| `requestTimeoutSeconds` | integer | `30` | `30` | Deadline for each provider request |
| `maxCallsPerFile` | integer | `4` | `20` | Maximum admitted chunks associated with one selected file |
| `maxCallsPerPullRequest` | integer | `40` | `100` | Maximum provider calls for one PR |
| `maxRepairCallsPerPullRequest` | integer | `3` | `10` | Additional targeted calls for invalid responses or ungrounded evidence; set to `0` to disable repair |
| `minSeverity` | string | `high` | n/a | Lowest reported severity: `critical`, `high`, `medium`, `low`, or `info` |
| `skipPaths` | string[] | `[]` | n/a | Glob-like path exclusions using `*` and `**` |
| `skipExtensions` | string[] | `[]` | n/a | Additional suffix exclusions, each beginning with `.`; built-in prose exclusions cannot be re-enabled |
| `concurrency` | integer | `2` | `2` | Per-scan request concurrency; deployment-wide concurrency is governed separately |
| `prompt` | string or null | built-in | n/a | Replaces the analysis instructions; the trust and JSON response contract is always appended |
| `boostPatterns` | string[] | `[]` | n/a | Additional regular expressions converted to non-evidentiary routing signals |
| `cache.enabled` | boolean | `false` | n/a | Allows this repository to use the deployment's Spectre response cache |
| `cache.positiveTtlSeconds` | integer | `86400` | `604800` | Absolute TTL for validated finding-bearing responses |
| `cache.negativeTtlSeconds` | integer | `3600` | `604800` | Absolute TTL for validated clean responses |
| `astSignals.mode` | `off`, `shadow`, or `enabled` | `off` | n/a | Structural routing rollout mode. Shadow mode cannot change selection or coverage |
| `astSignals.maxFiles` | integer | `200` | `500` | Maximum files admitted to structural analysis |
| `astSignals.maxTotalBytes` | integer | `2097152` | `67108864` | Maximum total UTF-8 source bytes parsed structurally |
| `astSignals.timeoutSeconds` | integer | `3` | `30` | Structural analysis and isolated-worker deadline |

The call and input budgets are separate. `maxInputBytes` and `maxDiffLines` apply to each request; `maxCallsPerPullRequest` bounds initial analysis requests. Up to `maxRepairCallsPerPullRequest` additional calls can correct invalid structured output or re-ground evidence for existing identity-locked candidates. Therefore, a configured worst-case user-payload ceiling is approximately `maxInputBytes * (maxCallsPerPullRequest + maxRepairCallsPerPullRequest)`, plus the repeated system prompt and generated output. The whole-PR path normally reduces repeated prompt overhead for small changes.

## Response cache

The optional Redis response cache reuses only exact, PR-scoped Spectre requests. Its identity binds the immutable GitHub repository ID, installation, PR number, actual merge base, provider/model, scanner build and configuration, prompts, response schema, Git blob OIDs, full HEAD source hashes, and changed ranges. `headSha` is deliberately omitted so an unchanged chunk can survive a later push; changing any source blob used by a chunk always changes its key.

Cached values are HMAC-signed and contain bounded raw provider output. Positive responses include the exact source evidence returned with findings, so the cache has the same confidentiality requirements as scanned source and is persisted in AOF by the bundled Redis. Prompts and full source files are not stored as values. Every hit is parsed with the current schema and exact evidence is grounded against current HEAD source again. Invalid, expired, corrupted, oversized, or ungrounded entries are deleted and scanned live. Redis failures also fall back to live analysis. Invalid, repaired, cancelled, timed-out, rate-limited, circuit-open, or otherwise incomplete responses are never cached.

Finding-bearing responses are eligible after one complete live scan. Clean responses are probationary until two independent complete live scans agree, preventing one stochastic false negative from becoming sticky. Existing file and PR call caps remain logical coverage limits, so cache warmth does not admit files that a cold scan would cap.

Both repository configuration and deployment mode must enable caching. `SPECTRE_CACHE_MODE` supports `off`, `write-only`, `verify`, and `read-write`. `verify` reads and compares entries but always uses the live response. The shared-Redis deployment keeps Redis in `noeviction` mode and enforces `SPECTRE_CACHE_MAX_BYTES` over serialized cache values; its cache script deletes only cache keys. Redis object/index overhead and AOF amplification are outside that payload budget, so memory, disk, and latency must still be monitored.

The shared Redis service is a trusted control-plane dependency: an actor able to rewrite BullMQ jobs can already change what commit Layne scans, and HMAC signatures detect cache corruption or forgery but cannot prevent replay of an older still-valid signed value. Use `SPECTRE_CACHE_REDIS_URL` with an isolated, access-controlled Redis endpoint when the cache should have a separate failure or trust boundary.

## Incomplete outcomes

Spectre records incomplete coverage for file caps, oversized or unavailable files, unprojectable Git content, call caps, hunks that require conservative split/truncation accounting, invalid or output-truncated responses that survive targeted retry, evidence that remains ungrounded after repair, request failures/timeouts, governor queue/rate denials, and open provider circuits. The Check Run summary includes coverage counters and a reason.

Most incomplete Spectre results with no blocking finding produce GitHub conclusion `neutral`, use `onIncomplete`/`removeOnIncomplete` labels, and use the incomplete PR comment. The exception is `high-risk-file-cap-exceeded`: when score-12-or-higher files remain unscanned after primary and secondary selection, the conclusion is `failure`, failure labels apply, and the Check Run summary lists up to ten bounded file paths with scores and routing signals plus any additional count. This is a coverage failure, not a synthetic malicious-code finding, so no inline annotation is created for the omitted files.

Valid findings from scanned files are still validated, suppressed, annotated, commented on, and notified normally when high-risk overflow occurs. Exception approvals can waive those individual findings but cannot waive the coverage failure. Other incomplete reasons remain neutral under the current rollout policy. See [Rollout gate](#rollout-gate) for the criteria required before changing those reasons.

## Governor

Every request passes through a provider-scoped concurrency, rate, and circuit-breaker governor. `SPECTRE_GOVERNOR_BACKEND=in_process` is the default and limits only one worker process. Set `SPECTRE_GOVERNOR_BACKEND=redis` for deployment-wide limits shared by horizontally scaled workers through `REDIS_URL`.

| Variable | Default | Hard maximum | Description |
|---|---:|---:|---|
| `SPECTRE_GOVERNOR_BACKEND` | `in_process` | n/a | `in_process` or `redis` |
| `SPECTRE_GLOBAL_CONCURRENCY` | `4` | `100` | Concurrent provider requests per provider |
| `SPECTRE_REQUESTS_PER_MINUTE` | `35` | `10000` | Sustained request rate per provider |
| `SPECTRE_REQUEST_BURST` | min(`35`, RPM) | configured RPM | Burst capacity per provider |
| `SPECTRE_QUEUE_TIMEOUT_MS` | `2000` | `60000` | Time waiting for a concurrency lease |
| `SPECTRE_CIRCUIT_FAILURES` | `3` | `100` | Retryable failures that open the circuit |
| `SPECTRE_CIRCUIT_WINDOW_SECONDS` | `60` | `3600` | Failure counting window |
| `SPECTRE_CIRCUIT_COOLDOWN_SECONDS` | `60` | `3600` | Open-circuit cooldown before a half-open probe |

The Redis backend uses renewable leases and recovers expired leases. Redis backend errors and denied acquisitions make affected chunks incomplete; they do not silently bypass the governor.

## Cancellation

The job deadline aborts Spectre selection, governor waits, in-flight provider requests, and further chunk scheduling. Spectre accounts for interrupted chunks internally, but worker-level cancellation is rethrown: a deadline before terminal Check Run publication causes BullMQ retry/final failure rather than a normal neutral result. If publication already completed, only remaining best-effort side effects are aborted and the job is not retried. Per-request provider deadlines remain ordinary incomplete coverage. The worker also fences publication so late work cannot publish a stale success.

## Evaluation

### Deterministic simulator

```bash
npm run spectre:simulate
# Optional fixture file:
npm run spectre:simulate -- path/to/simulations.json
```

The simulator materializes scripted base/head snapshots in a temporary Git repository and exercises Git change extraction, typed diff parsing, whole-PR/chunk planning, response validation, findings, status counters, and cleanup. It emits one machine-readable JSON report and exits non-zero on fixture mismatch.

Responses are scripted. Its precision, recall, and F1 fields measure agreement with those scripts only; they do **not** measure LLM semantic quality.

### Manual semantic evaluators

```bash
# Authenticated Claude Code CLI
npm run spectre:eval

# Authenticated Codex CLI
npm run spectre:eval:codex
```

### Local AST battle test

```bash
# Fully local and deterministic: no model or network inference
npm run spectre:battle:ast

# Replay pinned public GitHub PRs through lexical and AST shadow routing
# Requires an authenticated GitHub CLI; no model is invoked
npm run spectre:replay:prs -- path/to/your-public-pr-manifest.json report.json

# Run the expanded semantic corpus through Codex with production AST routing
# (local CLI orchestration, but REMOTE inference and source disclosure)
SPECTRE_CORPUS=fixtures/spectre-ast-corpus.json \
SPECTRE_EVAL_AST_MODE=enabled \
npm run spectre:eval:codex

# Run the same corpus through Claude for a provider differential
SPECTRE_CORPUS=fixtures/spectre-ast-corpus.json \
SPECTRE_EVAL_AST_MODE=enabled \
npm run spectre:eval

# Compare paired base-case/run results without invoking a model
npm run spectre:eval:compare -- before.json after.json differential.json
```

`spectre:battle:ast` parses inert fixture strings and exercises the production shared router without calling any model. It covers 60+ JS/TS, Python, and Go routing cases, expands deterministic identifier, whitespace, and line-break variants to more than 500 analyses, checks 60 alias/decoy adversarial transformations, and injects parser and worker limit failures. `fixtures/spectre-ast-corpus.json` is a separate expanded semantic corpus, while `fixtures/spectre-ast-saturation-corpus.json` forces a file-cap selection delta for causal off-versus-enabled evaluator comparisons. The 33-case `fixtures/spectre-corpus.json` baseline remains unchanged.

`spectre:replay:prs` is a provider-independent routing benchmark. Its manifest pins public pull requests by base and head commit, labels review-critical files with a rationale, and defines file caps. The script obtains comparison patches and immutable blobs through `gh`, applies production file filtering and AST shadow routing with `secondaryFileCap: 0`, then reports lexical and augmented routing recall, beneficial promotions, harmful displacements, and selection churn. It accesses GitHub but sends no source to an LLM; review manifest labels before using the scores as a quality gate.

The Codex CLI is only local orchestration. **Codex inference is remote**, just like Claude inference, and the supplied source is disclosed to the provider. Checked-in semantic and routing fixtures must contain only synthetic examples or code already approved for public disclosure. Never add private production source, credentials, live endpoints, or customer data to either corpus.

Both commands use `fixtures/spectre-corpus.json` by default and run cases through production file filtering, the shared lexical/AST router, deterministic selection, request planning, response schemas, and parsing. Corpus cases may contain one file or a related multi-file change. Expected and actual findings are scored as file-aware multisets, so wrong-file attribution or a missed second behavior with the same rule counts as a false positive or false negative. Reports include aggregate and per-rule precision, recall, F1, false positives, false negatives, malformed responses, errors, bounded routing diagnostics, repeat stability, and reproducibility hashes.

Cases may include `tags` and a narrow `routing` object. Supported routing overrides are `fileCap`, `secondaryFileCap`, `maxDiffLines`, and `astSignals` fields `mode`, `maxFiles`, `maxTotalBytes`, and `timeoutSeconds`. The evaluator environment AST mode takes precedence over a per-case mode and never modifies `config/layne.json`. The legacy top-level case `maxDiffLines` remains accepted for the baseline corpus.

Both evaluators are **manual-only and must never run in CI or tests**. They enforce this at startup. The Codex subprocess is ephemeral, ignores Codex user configuration/rules, uses a read-only sandbox and isolated working, home, temporary, and config directories, receives prompts over stdin, and inherits only a small execution/authentication environment allowlist. The evaluator copies only the local Codex authentication file into the isolated config when it exists. Cancellation terminates the isolated process group before those directories are removed.

The local isolation and read-only sandbox do not prevent source disclosure: Codex receives the supplied source in its prompt and sends it to the remote Codex service. The Claude evaluator invokes the locally authenticated `claude` CLI with tools disabled, no session persistence, a JSON schema, and a default per-provider-call budget of USD 0.25. One case can require multiple calls when production request planning splits its diff. The Codex evaluator invokes the locally authenticated `codex` CLI and has no Layne-enforced monetary cap. Both can incur charges and send corpus data or files under `SPECTRE_SOURCE_ROOT` to their respective provider. Never point `SPECTRE_SOURCE_ROOT` at source that the evaluator account is not authorized to disclose.

Common evaluator settings:

| Variable | Default | Purpose |
|---|---|---|
| `SPECTRE_CORPUS` | `fixtures/spectre-corpus.json` | Corpus JSON path |
| `SPECTRE_SOURCE_ROOT` | none | Root for cases that name a file but omit inline content |
| `SPECTRE_EVAL_OWNER` / `SPECTRE_EVAL_REPO` | `example-org` / `example-repo` | Repository config whose Spectre prompt is evaluated; defaults to global settings when no matching repository is configured |
| `SPECTRE_EVAL_OFFSET` / `SPECTRE_EVAL_LIMIT` | `0` / `0` | Corpus slice; limit `0` means all remaining cases |
| `SPECTRE_EVAL_TAGS` | none | Comma-separated tag filter matching any listed tag; offset and limit apply after filtering |
| `SPECTRE_EVAL_REPEATS` | `1` | Runs per selected base case, from `1` through `10` |
| `SPECTRE_EVAL_AST_MODE` | repository config, normally `off` | Ephemeral `off`, `shadow`, or `enabled` router mode override |
| `SPECTRE_EVAL_OUTPUT` | evaluator-specific report file | JSON report path |
| `SPECTRE_EVAL_MODEL` | `haiku` for Claude; CLI default for Codex | Evaluator model |
| `SPECTRE_EVAL_CODEX_MODEL` | falls back to `SPECTRE_EVAL_MODEL` | Codex-only model override |
| `SPECTRE_EVAL_BUDGET_PER_CALL` | `0.25` | Claude-only maximum USD per planned provider call |
| `SPECTRE_EVAL_TIMEOUT_MS` | `45000` | Codex-only per-case timeout; maximum `300000` |

The JSON report records the full corpus size, tag-matched size, selected base-case count, offset, limit, repeats, and each result's base case/run index and stability. Reproducibility metadata includes the structural rules version, effective AST mode, corpus/config/prompt SHA-256 values, Git HEAD when available, Node/platform, model, CLI timeout, and effective Spectre provider-request timeout. Routing diagnostics intentionally exclude raw parser errors or diagnostics.

Thresholds are optional and have no defaults. When unset, the command writes scores without failing on quality. When set, any violation exits non-zero:

| Variable | Range | Failure condition |
|---|---:|---|
| `SPECTRE_EVAL_MIN_PRECISION` | `0` to `1` | Aggregate precision is lower |
| `SPECTRE_EVAL_MIN_RECALL` | `0` to `1` | Aggregate recall is lower |
| `SPECTRE_EVAL_MIN_F1` | `0` to `1` | Aggregate F1 is lower |
| `SPECTRE_EVAL_MAX_FALSE_POSITIVES` | non-negative | Aggregate false positives are higher |
| `SPECTRE_EVAL_MAX_FALSE_NEGATIVES` | non-negative | Aggregate false negatives are higher |
| `SPECTRE_EVAL_MAX_MALFORMED` | non-negative | Malformed responses are higher |
| `SPECTRE_EVAL_MAX_ERRORS` | non-negative | Evaluator errors are higher |

## Safe-pattern changes

Use prompt guidance, not broad path suppression, to address recurring benign patterns. A safe-pattern change is acceptable only when:

1. A minimal hard-negative regression fixture reproduces the false positive.
2. A paired malicious fixture proves that the narrowed wording still catches hostile behavior using the same primitive or path class.
3. Both manual evaluators are reviewed against the previous accepted report, with explicit thresholds set for the run.
4. A security reviewer approves the prompt/config diff and recorded reports.
5. The change is deployed gradually while incomplete and finding metrics are observed.

Do not add broad exclusions for code-bearing formats or categorical "never report" wording as false-positive tuning; attackers can deliberately move behavior into those blind spots. The built-in prose boundary is a scanner-scope decision, not a recurring-false-positive suppression. Keep the previous prompt/config ready for immediate rollback. Roll back if a malicious regression appears, false negatives increase, malformed/errors exceed the accepted threshold, or production alerts fire after deployment.

## Metrics and alerts

Provider-labelled scan, chunk, latency, input-size, governor, circuit, backend-error, and lease-recovery metrics are documented on the [Metrics](../metrics.md) page. The supplied Grafana dashboard includes Spectre coverage, incomplete reasons, provider latency, chunks, governor denials, circuit state, backend errors, and lease recoveries. Prometheus rules cover sustained incomplete rates, provider failure spikes, governor denials, open circuits, Redis errors, and lease recovery anomalies.

## Rollout gate

Keep incomplete results other than `high-risk-file-cap-exceeded` neutral until all of these objective conditions hold:

1. At least 30 consecutive production days and 500 enabled Spectre scans have been observed, including at least 100 scans for every provider that will be fail-closed.
2. For 14 consecutive days, incomplete outcomes are at or below 1% overall and 2% for each provider, with no single incomplete reason above 1%.
3. For the same 14 days, no `LayneSpectreSustainedIncompleteRate`, `LayneSpectreProviderFailureSpike`, `LayneSpectreGovernorDenialSpike`, `LayneSpectreCircuitOpen`, `LayneSpectreRedisGovernorErrors`, or `LayneSpectreLeaseRecoveryAnomaly` alert fires.
4. Provider p95 request latency remains below 24 seconds, 80% of the default request deadline, for each provider.
5. The accepted semantic-evaluation baseline has no errors or malformed responses, meets the organization-approved precision/recall/F1 thresholds, and has no malicious-fixture regression.
6. Security and operations approve a staged fail-closed rollout and a tested rollback to neutral.

After promotion, continue observing the same alerts and rates. A breach of the rate, latency, evaluator, or alert criteria triggers rollback to neutral while the cause is investigated.

## Examples

**Amazon Bedrock:**

```json
{
  "owner/repo": {
    "spectre": {
      "enabled": true,
      "provider": "amazon-bedrock",
      "model": "anthropic.claude-haiku-4-5-20251001-v1:0"
    }
  }
}
```

**Explicitly reduce spend:**

```json
{
  "owner/repo": {
    "spectre": {
      "enabled": true,
      "provider": "openai",
      "model": "gpt-4o-mini",
      "fileCap": 10,
      "secondaryFileCap": 0,
      "maxInputBytes": 32768,
      "maxOutputTokens": 800,
      "maxCallsPerFile": 2,
      "maxCallsPerPullRequest": 12
    }
  }
}
```

For the most effective cost control, defer Layne until a successful CI workflow or job with the [`workflow_run` or `workflow_job` trigger](../configuration.md#trigger).
