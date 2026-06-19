# Extending Layne

We wrote Layne to reflect our internal workflow at Rocket.Chat, but Layne is simply an orchestrator - the fact that we ship it with Trufflehog, Semgrep, and Claude support doesn't mean you need/should use those. Layne was created by a small application security team for other application security teams.

You can - and we'd argue you should - customize Layne. Rewrite it, extend it, add new features, contribute to the open-source repository, go crazy. Layne is here to help your team have a scalable workflow that makes sense in your context. 

## Adding a New Scanner

Scanners live in `src/adapters/` as individual modules. Each adapter runs a tool and converts its output to Layne's finding format. Adding a new one takes three steps.

### 1. Write the adapter

Create `src/adapters/mytool.js`. The adapter exports one async function that receives a context object and returns an array of findings.

```js title="src/adapters/mytool.js"
import { execFile } from 'child_process';

export async function runMytool({ workspacePath, changedFiles, toolConfig = {} }) {
  // changedFiles is an array of paths relative to the repo root.
  // Pass workspacePath + '/' + file to get absolute paths on disk.
  // toolConfig holds the resolved per-repo config block for this tool.

  const stdout = await exec('mytool', ['--json', workspacePath]);

  let results;
  try {
    results = JSON.parse(stdout);
  } catch {
    return [];
  }

  return results.map(r => toFinding(r, workspacePath));
}

function toFinding(result, workspacePath) {
  // Strip the workspacePath prefix so the path is relative to the repo root.
  // The GitHub Checks API requires repo-root-relative paths for annotations.
  const prefix = workspacePath + '/';
  const file = result.path?.startsWith(prefix)
    ? result.path.slice(prefix.length)
    : result.path ?? 'unknown';

  return {
    file,                            // repo-root-relative path  (required)
    line:     result.line ?? 1,      // line number              (required)
    severity: 'high',                // 'critical' | 'high' | 'medium' | 'low' | 'info'
    message:  result.message,        // annotation body text
    ruleId:   `mytool/${result.id}`, // stable identifier for the rule
    tool:     'mytool',              // used in the check run summary
  };
}

// Resolve with stdout even on non-zero exit so findings are not lost.
// Many security tools exit non-zero when they find issues (e.g. Semgrep
// exits 1, Trufflehog exits 183). Only reject when there is no output at all.
function exec(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (err, stdout) => {
      if (err && !stdout) reject(err);
      else resolve(stdout ?? '');
    });
  });
}
```

**Finding fields:**

| Field | Type | Description |
|---|---|---|
| `file` | `string` | Path relative to the repo root (strip `workspacePath + '/'`) |
| `line` | `number` | Line number for the annotation (use `1` if unavailable) |
| `severity` | `'critical' \| 'high' \| 'medium' \| 'low' \| 'info'` | Controls annotation styling and whether the check fails |
| `message` | `string` | Body text of the inline annotation |
| `ruleId` | `string` | Stable identifier used to deduplicate or suppress findings |
| `tool` | `string` | Name shown in the check run summary |

### 2. Register the adapter in the dispatcher

Open `src/dispatcher.js` and add your adapter to the `Promise.all` call:

```js title="src/dispatcher.js"
import { runTrufflehog } from './adapters/trufflehog.js';
import { runSemgrep }    from './adapters/semgrep.js';
import { runMytool }     from './adapters/mytool.js';   // add this

export async function dispatch({ scanContext, changedLineRanges, owner, repo }) {
  const { scanWorkspacePath, scanFiles } = scanContext;

  const scanConfig = await loadScanConfig({ owner, repo });

  const [trufflehogFindings, semgrepFindings, mytoolFindings] = await Promise.all([
    runTrufflehog({ workspacePath: scanWorkspacePath, changedFiles: scanFiles, toolConfig: scanConfig.trufflehog }),
    runSemgrep({ workspacePath: scanWorkspacePath, changedFiles: scanFiles, toolConfig: scanConfig.semgrep }),
    runMytool({ workspacePath: scanWorkspacePath, changedFiles: scanFiles, toolConfig: scanConfig.mytool }),  // add this
  ]);

  return [...trufflehogFindings, ...semgrepFindings, ...mytoolFindings];
}
```

`scanContext.scanWorkspacePath` is the directory containing the files to scan (may be a diff-only projection in `diff_only` mode). `scanContext.scanFiles` is the list of changed file paths relative to the repo root. `owner` and `repo` are also available if the tool needs them.

### 3. Install the tool in the Dockerfile

Add an `ARG` for the version and a `RUN` step to install the binary in the `runtime` stage of the `Dockerfile`:

```dockerfile title="Dockerfile"
ARG MYTOOL_VERSION=1.0.0

RUN curl -fsSL https://github.com/example/mytool/releases/download/v${MYTOOL_VERSION}/mytool-linux-amd64 \
      -o /usr/local/bin/mytool \
  && chmod +x /usr/local/bin/mytool
```

Pin the version so builds are reproducible. Pass `--build-arg MYTOOL_VERSION=x.y.z` to `docker compose build` to upgrade.


## How Findings Become GitHub Annotations

Adapters return findings - they don't call the reporter directly. Understanding this flow helps when debugging or adding new scanners:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Scanner A  │     │  Scanner B  │     │  Scanner C  │     │    ...      │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │                   │
       │ findings[]        │ findings[]        │ findings[]        │
       └───────────────────┴───────────────────┴───────────────────┘
                                   │
                                   ▼
                            ┌─────────────┐
                            │  dispatcher │  (src/dispatcher.js)
                            └──────┬──────┘
                                   │ merged findings[]
                                   ▼
                    ┌──────────────────────────────┐
                    │  filterFindingsToChangedLines │  (src/scan-context.js)
                    │  (diff_only mode only)        │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │    validateFindingLocations   │  (src/location-validator.js)
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │       suppressFindings        │  (src/suppressor.js)
                    │  (drops findings with a       │
                    │   SECURITY: comment at base)  │
                    └──────────────┬───────────────┘
                                   │ actionable findings[]
                                   ▼
                            ┌─────────────┐
                            │   reporter  │  (src/reporter.js)
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
3. Returns the merged array to the worker

**What happens after the dispatcher:**

Before findings reach the reporter, the worker applies three more passes:

- **`filterFindingsToChangedLines`** - in `diff_only` mode, drops findings that fall outside the actual changed line ranges. In `changed_files` mode (the default) this is a no-op.
- **`validateFindingLocations`** - checks that each finding's line number exists in the actual file content and resolves the precise start/end line range. Claude findings that cannot be resolved to an exact location are marked ineligible and dropped.
- **`suppressFindings`** - reads each flagged line at the merge-base commit and drops the finding if a `// SECURITY:` comment is already present there (opt-out for pre-existing accepted findings).

**What the reporter does:**

The reporter (`src/reporter.js`) receives the merged findings array and produces GitHub Check Run output:

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

The overall Check Run conclusion determines whether GitHub shows a green check or red ✗:

| Condition | Conclusion |
|---|---|
| One or more `critical` / `high` findings | `failure` |
| No blocking findings | `success` |

When branch protection requires the Layne check, `failure` blocks the PR from merging.

### Annotation summary

The reporter generates a human-readable summary line shown in the Check Run header:

```
Found 3 issue(s): 0 critical, 1 high, 1 medium, 1 low.
```

### Annotation chunking

GitHub's API limits Check Runs to 50 annotations per request. The reporter batches automatically - adapters don't need to worry about this limit. The worker posts chunked requests to GitHub, with the final request setting `status: completed`.


## Adding a New Notifier

Notifiers live in `src/notifiers/` as individual modules. Each notifier sends findings to a chat platform or webhook. Adding a new one takes four steps.

### 1. Write the notifier

Create `src/notifiers/yourservice.js`. Export one async function named `notify` that matches the notifier contract. It must never throw - catch all errors internally so a notification failure never affects the scan result or Check Run.

```js title="src/notifiers/yourservice.js"
import { buildContext, renderTemplate } from './template.js';

const DEFAULT_TEMPLATE = '🦴 {{total}} finding(s) in {{prUrl}}';

function resolveUrl(webhookUrl) {
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

export async function notify({ findings, owner, repo, prNumber, toolConfig }) {
  const url = resolveUrl(toolConfig.webhookUrl);
  if (!url) return;

  const ctx  = buildContext(findings, owner, repo, prNumber /* , headSha */);
  const text = renderTemplate(toolConfig.template ?? DEFAULT_TEMPLATE, ctx);

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(`[yourservice] notification failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[yourservice] notification failed: ${err.message}`);
  }
}
```

**Notifier contract:**

| Parameter | Type | Description |
|---|---|---|
| `findings` | `Array` | All findings from all scanners for this scan |
| `owner` | `string` | GitHub org or user name |
| `repo` | `string` | Repository name |
| `prNumber` | `number` | Pull request number |
| `toolConfig` | `object` | The resolved config for this notifier from `config/layne.json` |

Use `buildContext(findings, owner, repo, prNumber)` to build the template context and `renderTemplate(template, ctx)` to render `{{variable}}` placeholders. An optional fifth argument `headSha` can be passed to generate linked file references in the `{{findings}}` table variable - notifiers that don't use `{{findings}}` can safely omit it. See [Template variables](notifiers.md#template-variables) for the full list.

The `$ENV_VAR` resolution pattern keeps secrets out of `config/layne.json`. Any `webhookUrl` value starting with `$` is resolved from `process.env` at runtime. If the variable is not set, skip the notification and log a warning.

### 2. Register the notifier

Open `src/notifiers/index.js` and add two lines:

```js title="src/notifiers/index.js"
import { notify as notifyYourservice } from './yourservice.js';  // add this

const NOTIFIERS = {
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
