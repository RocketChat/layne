# Extending Layne

---

## Adding a New Scanner

Each security tool is an **adapter** — a single file in `src/adapters/` that runs the tool and converts its output to Layne's common finding format. Adding a new tool takes three steps.

### 1. Write the adapter

Create `src/adapters/mytool.js`. The adapter exports one async function that receives a context object and returns an array of findings.

```js
// src/adapters/mytool.js
import { execFile } from 'child_process';

export async function runMytool({ workspacePath, changedFiles }) {
  // changedFiles is an array of paths relative to the repo root.
  // Pass workspacePath + '/' + file to get absolute paths on disk.

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

```js
import { runTrufflehog } from './adapters/trufflehog.js';
import { runSemgrep }    from './adapters/semgrep.js';
import { runMytool }     from './adapters/mytool.js';   // add this

export async function dispatch({ workspacePath, changedFiles, baseSha, baseRef, labels, owner, repo }) {
  const [trufflehogFindings, semgrepFindings, mytoolFindings] = await Promise.all([
    runTrufflehog({ workspacePath, changedFiles }),
    runSemgrep({ workspacePath, changedFiles }),
    runMytool({ workspacePath, changedFiles }),           // add this
  ]);

  return [...trufflehogFindings, ...semgrepFindings, ...mytoolFindings];
}
```

The `dispatch` function also receives `baseSha`, `baseRef`, `labels`, `owner`, and `repo` — pass any of these to your adapter if the tool needs them (for example, to use a custom ruleset based on repository labels).

### 3. Install the tool in the Dockerfile

Add an `ARG` for the version and a `RUN` step to install the binary in the `runtime` stage of the `Dockerfile`:

```dockerfile
ARG MYTOOL_VERSION=1.0.0

RUN curl -fsSL https://github.com/example/mytool/releases/download/v${MYTOOL_VERSION}/mytool-linux-amd64 \
      -o /usr/local/bin/mytool \
  && chmod +x /usr/local/bin/mytool
```

Pin the version so builds are reproducible. Pass `--build-arg MYTOOL_VERSION=x.y.z` to `docker compose build` to upgrade.

---

## How Findings Become GitHub Annotations

Adapters return findings — they don't call the reporter directly. Understanding this flow helps when debugging or adding new scanners:

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
                                   │
                                   │ merged findings[]
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

**What the reporter does:**

The reporter (`src/reporter.js`) receives the merged findings array and produces GitHub Check Run output:

### Severity mapping

GitHub Check Runs support three annotation levels: `failure`, `warning`, and `notice`.

| Finding severity | GitHub level | Merge blocked? |
|---|---|---|
| `critical` | `failure` | Yes — branch protection will block merge |
| `high` | `failure` | Yes — branch protection will block merge |
| `medium` | `warning` | No — visible in PR files tab, yellow marker |
| `low` | `notice` | No — informational, minimal visibility |
| `info` | `notice` | No — informational |

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

GitHub's API limits Check Runs to 50 annotations per request. The reporter batches automatically — adapters don't need to worry about this limit. The worker posts chunked requests to GitHub, with the final request setting `status: completed`.
