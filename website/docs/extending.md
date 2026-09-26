# Extending Layne

We wrote Layne to reflect our internal workflow at Rocket.Chat, but Layne is simply an orchestrator - the fact that we ship it with Trufflehog, Semgrep, and Claude support doesn't mean you need/should use those. Layne was created by a small application security team for other application security teams.

You can - and we'd argue you should - customize Layne. Rewrite it, extend it, add new features, contribute to the open-source repository, go crazy. Layne is here to help your team have a scalable workflow that makes sense in your context. 

## Adding a New Scanner

Scanners live in `src/adapters/` as TypeScript modules. Each adapter converts one tool's output into Layne findings and reports whether it completed all intended work. Adding one touches the shared types, configuration, dispatcher, adapter, and usually the worker image.

### 1. Extend the shared types

Layne deliberately uses a closed scanner union. In `src/types.ts`:

1. Add the scanner name to `Tool`.
2. Add a finding interface and include it in `RawFinding`.
3. Add its configuration interface and field in `ScanConfig`.
4. Add its status field in `AdapterStatuses`.

```ts title="src/types.ts"
export type Tool =
  | 'semgrep'
  | 'trufflehog'
  | 'claude'
  | 'spectre'
  | 'dep-doctor'
  | 'mytool';

export interface MytoolFinding extends BaseFinding {
  tool: 'mytool';
}

export type RawFinding =
  | SemgrepFinding
  | TrufflehogFinding
  | ClaudeRawFinding
  | SpectreRawFinding
  | DepDoctorFinding
  | MytoolFinding;

export interface MytoolConfig {
  enabled: boolean;
  extraArgs: string[];
}

export interface AdapterStatuses {
  // existing scanners...
  mytool: AdapterStatus;
}

export interface ScanConfig {
  // existing configuration...
  mytool: MytoolConfig;
}
```

`AdapterResult<Finding, Status>` is the common adapter return type. Most adapters use the base `AdapterStatus`; scanners with useful bounded counters can define a status interface that extends it.

### 2. Add defaults and configuration validation

Add `MytoolConfig` to the explicit type import in `src/config.ts`, add a frozen default block, then merge global and per-repo values in `loadScanConfig()` alongside the existing scanner blocks. Add `mytool` to the repository/global key allowlists in `src/config-validator.ts` and validate each supported option. Unknown top-level keys fail `npm run validate-config`; nested allowlisting varies by block, so add explicit nested-key checks if your scanner should reject unknown options. Editing only `config/layne.json` is not enough.

```ts title="src/config.ts"
mytool: Object.freeze({
  enabled: false,
  extraArgs: [],
} as MytoolConfig),

// In loadScanConfig():
mytool: {
  ...DEFAULT_CONFIG.mytool,
  ...(globalConfig.mytool ?? {}),
  ...(repoOverrides.mytool ?? {}),
},
```

### 3. Write the adapter

Create `src/adapters/mytool.ts`. Pass the job's `AbortSignal` through every cancellable operation and rethrow cancellation. Expected scanner failures should return `incomplete`; programming errors should still throw.

```ts title="src/adapters/mytool.ts"
import { join } from 'path';
import { exec, stripPrefix, throwIfAborted } from './helpers.js';
import type { AdapterResult, AdapterStatus, MytoolConfig, MytoolFinding } from '../types.js';

interface MytoolResult {
  path: string;
  line?: number;
  message: string;
  id: string;
}

function isMytoolResult(value: unknown): value is MytoolResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<MytoolResult>;
  return typeof result.path === 'string'
    && (result.line === undefined || (typeof result.line === 'number' && Number.isInteger(result.line) && result.line > 0))
    && typeof result.message === 'string'
    && typeof result.id === 'string';
}

export async function runMytool({ workspacePath, changedFiles, toolConfig, signal }: {
  workspacePath: string;
  changedFiles: string[];
  toolConfig: MytoolConfig;
  signal?: AbortSignal;
}): Promise<AdapterResult<MytoolFinding>> {
  throwIfAborted(signal);
  if (!toolConfig.enabled) return { findings: [], status: { outcome: 'disabled' } };
  if (changedFiles.length === 0) return { findings: [], status: { outcome: 'complete' } };

  let command;
  try {
    command = await exec(
      'mytool',
      ['--json', ...toolConfig.extraArgs, '--', ...changedFiles.map(file => join(workspacePath, file))],
      { cwd: workspacePath, signal },
    );
  } catch (err) {
    throwIfAborted(signal);
    console.error('[mytool] failed to run scanner:', (err as Error).message);
    const reason = (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'tool-unavailable'
      : 'command-failed';
    return { findings: [], status: { outcome: 'incomplete', reason } };
  }
  throwIfAborted(signal);

  let results: unknown[];
  try {
    const parsed = JSON.parse(command.stdout) as { results?: unknown[] };
    if (!Array.isArray(parsed.results)) throw new Error('missing results array');
    results = parsed.results;
  } catch {
    console.error('[mytool] scanner returned invalid JSON output');
    return { findings: [], status: { outcome: 'incomplete', reason: 'invalid-output' } };
  }

  const validResults = results.filter(isMytoolResult);
  const findings = validResults.map(result => ({
    file: stripPrefix(result.path, workspacePath),
    line: result.line ?? 1,
    severity: 'high' as const,
    message: result.message,
    ruleId: `mytool/${result.id}`,
    tool: 'mytool' as const,
  }));
  const status: AdapterStatus = validResults.length !== results.length
    ? { outcome: 'incomplete', reason: 'invalid-output' }
    : command.exitCode === 0
      ? { outcome: 'complete' }
      : { outcome: 'incomplete', reason: 'unexpected-exit' };
  return { findings, status };
}
```

The command helper returns stdout, stderr, and a numeric exit code. Treat tool-specific finding exit codes as complete, as Semgrep does for `1` and Trufflehog does for `183`. Log raw operational errors, but expose only bounded, stable reason codes in `status.reason`.

| Outcome | Meaning |
|---|---|
| `complete` | Every intended scan unit completed, including a valid clean result |
| `incomplete` | Some intended content could not be analyzed or output could not be trusted |
| `disabled` | Configuration intentionally disabled the scanner |

An incomplete adapter may still return valid partial findings. Layne publishes those findings and normally changes an otherwise-successful Check Run to `neutral`; do not discard useful findings just because another batch failed. Spectre's high-risk selected-file overflow is a scanner-specific blocking coverage policy, not the default contract for adapters.

**Finding fields:**

| Field | Type | Description |
|---|---|---|
| `file` | `string` | Path relative to the repo root (strip `workspacePath + '/'`) |
| `line` | `number` | Line number for the annotation (use `1` if unavailable) |
| `severity` | `'critical' \| 'high' \| 'medium' \| 'low' \| 'info'` | Controls annotation styling and whether the check fails |
| `message` | `string` | Body text of the inline annotation |
| `ruleId` | `string` | Stable rule identifier used in annotations and finding identity |
| `tool` | `Tool` | Closed scanner name used in summaries and status aggregation |

### 4. Register the adapter in the dispatcher

Open `src/dispatcher.ts`, add the adapter to the `Promise.all`, merge its findings, and expose its status:

```ts title="src/dispatcher.ts"
import { runMytool } from './adapters/mytool.js';

const [
  trufflehogResult,
  semgrepResult,
  claudeResult,
  spectreResult,
  depDoctorResult,
  mytoolResult,
] = await Promise.all([
  runTrufflehog({ workspacePath: scanWorkspacePath, changedFiles: eligibleFiles, toolConfig: scanConfig.trufflehog, signal }),
  runSemgrep({ workspacePath: repoWorkspacePath, changedFiles: eligibleFiles, toolConfig: scanConfig.semgrep, signal }),
  runClaude({ workspacePath: repoWorkspacePath, changedFiles: eligibleFiles, changedLineRanges, promptFiles: eligiblePromptFiles, toolConfig: scanConfig.claude, signal }),
  runSpectreWithStatus({ workspacePath: repoWorkspacePath, changedFiles: eligibleSpectreFiles, changedLineRanges, unifiedDiff: scanContext.unifiedDiff, pullRequestMetadata, toolConfig: scanConfig.spectre, signal }),
  runDepDoctor({ workspacePath: repoWorkspacePath, changedFiles: eligibleFiles, baseSha, toolConfig: scanConfig.depDoctor, signal }),
  runMytool({
    workspacePath: scanWorkspacePath,
    changedFiles: eligibleFiles,
    toolConfig: scanConfig.mytool,
    signal,
  }),
]);

return {
  findings: [
    ...trufflehogResult.findings,
    ...semgrepResult.findings,
    ...claudeResult.findings,
    ...spectreResult.findings,
    ...depDoctorResult.findings,
    ...mytoolResult.findings,
  ],
  statuses: {
    trufflehog: trufflehogResult.status,
    semgrep: semgrepResult.status,
    claude: claudeResult.status,
    spectre: spectreResult.status,
    'dep-doctor': depDoctorResult.status,
    mytool: mytoolResult.status,
  },
};
```

Choose scanner inputs deliberately:

| Input | Use it for |
|---|---|
| `scanWorkspacePath` + `scanFiles` | File scanners that can consume projected hunks in `diff_only`, such as Trufflehog |
| `repoWorkspacePath` + `scanFiles` | Parsers that require complete selected HEAD files, such as Semgrep; rely on the worker's exact changed-line post-filter in `diff_only` |
| `repoWorkspacePath` + `sourceFiles` | Scanners that require regular files from the HEAD commit regardless of scan mode |
| `unifiedDiff` | Diff-oriented scanners that understand Layne's typed base-to-head diff |
| `promptFiles` | Preformatted changed-hunk content prepared for prompt scanners |

The dispatcher filters ordinary scanner inputs above `maxFileSizeKb` and Dep Doctor lockfiles above `maxLockfileSizeKb` before invoking adapters. Define any additional scanner limits carefully: intentional exclusions such as unsupported binary formats can be part of the scanner's scope, while selected content that could not be analyzed should produce `incomplete` rather than a clean result.

### 5. Install the runtime dependency

If the scanner is an external binary, install a pinned version in the `runtime` stage of the `Dockerfile`:

```dockerfile title="Dockerfile"
ARG MYTOOL_VERSION=1.0.0

RUN wget -qO /usr/local/bin/mytool \
      https://github.com/example/mytool/releases/download/v${MYTOOL_VERSION}/mytool-linux-amd64 \
  && chmod +x /usr/local/bin/mytool
```

Pin the version so builds are reproducible. If developers run workers outside Docker, document the local installation too. Add adapter tests for disabled, clean, finding, malformed-output, operational-failure, partial-result, and cancellation paths.

### 6. Decide whether findings need evidence validation

Ordinary adapters provide trusted file and line coordinates, and Layne carries those coordinates into the annotation pipeline. Claude and Spectre are different: their model output must include exact evidence that `validateFindingLocations()` resolves against local HEAD content. Rejected Claude or Spectre candidates make that adapter incomplete and are not published.

If a new adapter accepts untrusted or probabilistic location claims, add it explicitly to the evidence-validation logic in `src/location-validator.ts`. Merely returning an `evidence` field does not opt a scanner into validation.


## How Findings Become GitHub Annotations

Adapters return findings and completion statuses - they don't call the reporter directly. Understanding this flow helps when debugging or adding new scanners:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Scanner A  │     │  Scanner B  │     │  Scanner C  │     │    ...      │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │                   │
       │ result            │ result            │ result            │
       └───────────────────┴───────────────────┴───────────────────┘
                                   │
                                   ▼
                            ┌─────────────┐
                            │  dispatcher │  (src/dispatcher.ts)
                            └──────┬──────┘
                                   │ { findings[], statuses }
                                   ▼
                    ┌──────────────────────────────┐
                    │    validateFindingLocations   │  (src/location-validator.ts)
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │  filterFindingsToChangedLines │  (src/scan-context.ts)
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │       suppressFindings        │  (src/suppressor.ts)
                    │  (drops findings with a       │
                    │   SECURITY: comment at base)  │
                    └──────────────┬───────────────┘
                                   │ actionable findings[]
                                   ▼
                            ┌─────────────┐
                            │ reporter + │  (src/reporter.ts +
                            │   worker   │   src/worker.ts)
                            └──────┬──────┘
                                   │
                                   │ { annotations, conclusion, summary }
                                   ▼
                            ┌─────────────┐
                            │  GitHub API │  (Check Runs)
                            └─────────────┘
```

**What the dispatcher does:**

1. Runs all scanners in parallel via `Promise.all`
2. Merges all findings into a single array
3. Returns the findings and every adapter's completion status to the worker

**What happens after the dispatcher:**

Before findings reach the reporter, the worker applies three more passes:

- **`validateFindingLocations`** - resolves exact evidence for Claude and Spectre. Their rejected candidates are dropped and make the adapter incomplete. Other adapters retain their supplied coordinates.
- **`filterFindingsToChangedLines`** - drops findings outside the actual changed line ranges according to the active scan context.
- **`suppressFindings`** - reads each flagged line at the merge-base commit and drops the finding if a `// SECURITY:` comment is already present there (opt-out for pre-existing accepted findings).

**What the reporter does:**

The reporter (`src/reporter.ts`) converts actionable findings into annotations and computes the finding-based success/failure result. The worker then applies incomplete coverage, Git preparation coverage, and exception approvals to choose the final Check Run conclusion.

### Severity mapping

GitHub Check Runs support three annotation levels: `failure`, `warning`, and `notice`.

| Finding severity | GitHub level | Merge blocked? |
|---|---|---|
| `critical` | `failure` | Yes - branch protection will block merge |
| `high` | `failure` | Yes - branch protection will block merge |
| `medium` | `warning` | No - visible in PR files tab, yellow marker |
| `low` | `notice` | No - informational, minimal visibility |
| `info` | `notice` | No - informational |

### Check Run conclusion

The final conclusion reflects both findings and whether configured scanners completed:

| Condition | Conclusion |
|---|---|
| One or more unexcepted `critical` / `high` findings | `failure` |
| No blocking findings, but scanner or Git coverage is incomplete | `neutral` |
| Spectre leaves score-12-or-higher files unscanned after both file caps | `failure` |
| No blocking findings and all enabled coverage completed | `success` |

Blocking findings take precedence over ordinary incomplete coverage. Exception approvals waive specific findings, not missing coverage, so an otherwise-approved scan remains `neutral` if any enabled adapter is ordinarily incomplete and remains `failure` for Spectre high-risk file-cap overflow. Disabled scanners do not make a result incomplete.

### Annotation summary

The reporter generates a human-readable summary line shown in the Check Run header:

```
Found 3 issue(s): 0 critical, 1 high, 1 medium, 1 low.
```

### Annotation chunking

GitHub's API limits Check Runs to 50 annotations per request. `completeCheckRun()` in `src/github.ts` batches automatically, with the final request setting `status: completed`; adapters don't need to handle this limit.


## Adding a New Notifier

Notifiers live in `src/notifiers/` as individual modules. Each notifier sends a projected final security state to a chat platform or webhook. Adding a new one takes four steps.

### 1. Write the notifier

Create `src/notifiers/yourservice.ts`. Export one async function named `notify` that matches `NotifyParams`. Return an explicit delivery result so the orchestrator can retry and acknowledge the notification. Rethrow job cancellation through the supplied signal.

```ts title="src/notifiers/yourservice.ts"
import { buildNotificationContext, renderTemplate } from './template.js';
import type { NotifierAttemptResult, NotifyParams } from './types.js';

const DEFAULT_TEMPLATE = '🦴 {{total}} finding(s) in {{prUrl}}';

function resolveUrl(webhookUrl: string | undefined): string | null {
  if (!webhookUrl) return null;
  if (webhookUrl.startsWith('$')) {
    const varName = webhookUrl.slice(1);
    const resolved = process.env[varName];
    if (!resolved) {
      console.warn(`[yourservice] webhookUrl env var $${varName} is not set - skipping notification`);
      return null;
    }
    return resolved;
  }
  return webhookUrl;
}

export async function notify({ state, projection, owner, repo, prNumber, headSha, toolConfig, signal }: NotifyParams): Promise<NotifierAttemptResult> {
  signal?.throwIfAborted();
  const url = resolveUrl(toolConfig.webhookUrl);
  if (!url) return { delivered: false, retryable: false, reason: 'webhook-unavailable' };

  const ctx  = buildNotificationContext(state, projection, owner, repo, prNumber, headSha);
  const text = renderTemplate(toolConfig.template ?? DEFAULT_TEMPLATE, ctx);

  try {
    signal?.throwIfAborted();
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
      ...(signal && { signal }),
    });
    if (!res.ok) {
      console.error(`[yourservice] notification failed: HTTP ${res.status}`);
      return { delivered: false, retryable: res.status >= 500, reason: `http-${res.status}` };
    }
    return { delivered: true };
  } catch (err) {
    signal?.throwIfAborted();
    console.error(`[yourservice] notification failed: ${(err as Error).message}`);
    return { delivered: false, retryable: true, reason: 'network-error' };
  }
}
```

**Notifier contract:**

| Parameter | Type | Description |
|---|---|---|
| `state` | `FinalSecurityState` | Final conclusion, findings, coverage issues, internal error, and effective exceptions |
| `projection` | `NotificationProjection` | Events, relevant findings, and fingerprint selected by this notifier's policy |
| `owner` | `string` | GitHub org or user name |
| `repo` | `string` | Repository name |
| `prNumber` | `number` | Pull request number |
| `toolConfig` | `object` | The resolved config for this notifier from `config/layne.json` |
| `headSha` | `string \| undefined` | Head SHA used to generate linked finding references |
| `signal` | `AbortSignal` | Job cancellation signal; pass it to network requests |

Use `buildNotificationContext(state, projection, owner, repo, prNumber, headSha)` to build the template context and `renderTemplate(template, ctx)` to render `{{variable}}` placeholders. See [Template variables](notifiers.md#template-variables) for the full list.

The `$ENV_VAR` resolution pattern keeps secrets out of `config/layne.json`. Any `webhookUrl` value starting with `$` is resolved from `process.env` at runtime. If the variable is not set, skip the notification and log a warning.

### 2. Register the notifier

Open `src/notifiers/index.ts` and add two lines:

```ts title="src/notifiers/index.ts"
import { notify as notifyYourservice } from './yourservice.js';  // add this

const NOTIFIERS: Record<string, (params: NotifyParams) => Promise<NotifierAttemptResult>> = {
  rocketchat: notifyRocketchat,
  slack:      notifySlack,
  yourservice: notifyYourservice,  // add this
};
```

### 3. Add the notifier key to your config

Open `config/layne.json` and add the notifier under `$global` or per-repo:

```json title="config/layne.json"
{
  "$global": {
    "notifications": {
      "yourservice": {
        "enabled":    true,
        "webhookUrl": "$YOURSERVICE_WEBHOOK_URL"
      }
    }
  }
}
```

Add `YOURSERVICE_WEBHOOK_URL` to your `.env` (and to your secrets store for production).

### 4. Add the environment variable

Add an entry for the webhook URL to your `.env.example` so other developers know it exists:

```bash title=".env.example"
# YOURSERVICE_WEBHOOK_URL=https://yourservice.example.com/hooks/...
```
