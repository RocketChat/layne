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
    severity: 'high',                // 'high' | 'medium' | 'low'
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
| `severity` | `'critical' \| 'high' \| 'medium' \| 'low'` | Controls annotation styling in the GitHub UI |
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

## Adding a New Notification Provider

Notifications are **modular**: each provider is an independent file in `src/notifiers/`. Adding a new provider (e.g. Slack) requires three steps and no changes to core scan logic.

### 1. Write the notifier

Create `src/notifiers/slack.js` exporting a `notify` function. The function must **never throw** — catch all errors internally so a notification failure never affects the scan result.

```js
// src/notifiers/slack.js

export async function notify({ findings, owner, repo, prNumber, toolConfig }) {
  const url = toolConfig.webhookUrl;
  if (!url) return;

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        text: `${findings.length} finding(s) in ${owner}/${repo} PR #${prNumber}`,
      }),
    });
    if (!res.ok) {
      console.error(`[slack] notification failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[slack] notification failed: ${err.message}`);
  }
}
```

### 2. Register the notifier in the orchestrator

Open `src/notifiers/index.js` and add two lines:

```js
import { notify as notifyRocketchat } from './rocketchat.js';
import { notify as notifySlack }      from './slack.js';        // add this

const NOTIFIERS = {
  rocketchat: notifyRocketchat,
  slack:      notifySlack,                                      // add this
};
```

The notifier key (`slack`) is what operators use in `config/layne.json` under `notifications`.

### 3. Write tests

Create `src/__tests__/notifiers/slack.test.js` following the same pattern as the Rocket.Chat test file. Use `vi.stubGlobal('fetch', vi.fn())` to mock HTTP calls.
