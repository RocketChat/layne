# Dep Doctor

<div style={{textAlign: 'center'}}>
  <img src="/img/dep-doctor.png" alt="Dep Doctor" width="160" />
</div>

Dep Doctor is a dependency health scanner that fires when a PR changes a lockfile. It checks **only newly-added packages** - packages that already existed in the lockfile at the merge base are ignored. This keeps findings actionable: the PR author introduced the dependency, so they can act on the finding.

It runs three checks:

1. **CVE detection** via [OSV-Scanner](https://google.github.io/osv-scanner/) - scans the lockfile against the [OSV](https://osv.dev) vulnerability database and reports any known CVEs.
2. **Abandoned packages** - queries the npm or PyPI registry API and flags packages whose last published version is older than `abandonedDays` (default: 2 years).
3. **Deprecated packages** - flags packages the registry has explicitly marked as deprecated (npm `deprecated` field, PyPI `Development Status :: 7 - Inactive` classifier).

Dep Doctor is **disabled by default** and must be opted in per repo. OSV-Scanner must be installed in the PATH of the worker process - if it is missing, the CVE check is skipped with a warning and health checks still run.


## What it detects

- **CVEs on new dependencies** - a package introduced by the PR that has a known vulnerability in the OSV database at or above `minCveSeverity`.
- **Abandoned packages** - a new dependency whose last published release is older than `abandonedDays` days. These are unmaintained and will accumulate unpatched vulnerabilities over time.
- **Deprecated packages** - a new dependency that the registry has officially marked as deprecated.

Dep Doctor never reports findings for dependencies that were already in the lockfile before the PR. If a pre-existing package is vulnerable, it will not appear as a finding - only the newly introduced ones are checked.


## How Layne runs it

1. The PR's changed files are scanned for known lockfile names. If none changed, Dep Doctor exits immediately.
2. For each changed lockfile, Layne fetches the **merge-base version** of the lockfile via `git show`. This establishes which packages already existed before the PR.
3. OSV-Scanner is run against the head lockfile. Packages with CVEs are cross-referenced against the merge-base set - only packages not present at merge base generate findings. CVEs below `minCveSeverity` are dropped.
4. The lockfile is also parsed directly to extract all packages. New packages (not in the merge-base version) are sent in batches of 5 to the npm or PyPI registry API for health checks. Go packages are not health-checked (Go's module proxy does not expose registry health metadata).
5. All findings (CVEs + health) are returned for annotation.

If the merge-base fetch fails (e.g. the lockfile is entirely new), all packages in the head lockfile are treated as new.

API errors in registry health checks are caught without failing the scan; they are only logged when `DEBUG_MODE=true`. OSV-Scanner errors are also caught - if `osv-scanner` is not found in PATH, a warning is always logged and CVE scanning is skipped for that run.


## Supported lockfiles

| Lockfile | Ecosystem | CVE scan | Abandoned | Deprecated |
|---|---|---|---|---|
| `package-lock.json` | npm | Yes | Yes | Yes |
| `yarn.lock` | npm | Yes | Yes | Yes |
| `pnpm-lock.yaml` | npm | Yes | No | No |
| `requirements.txt` | PyPI | Yes | Yes | Yes |
| `Pipfile.lock` | PyPI | Yes | No | No |
| `poetry.lock` | PyPI | Yes | No | No |
| `uv.lock` | PyPI | Yes | No | No |
| `go.sum` | Go | Yes | No | No |

Abandoned and deprecated checks require parsing the lockfile directly to enumerate individual packages. This is currently implemented for `package-lock.json`, `yarn.lock`, and `requirements.txt`. All other lockfile formats support CVE scanning only - OSV-Scanner handles them natively, but health checks are skipped.


## Rule IDs

| Rule ID | Description |
|---|---|
| `<CVE-ID>` | A newly-added dependency has the named CVE. Example: `CVE-2024-12345` |
| `abandoned/deprecated` | A newly-added dependency is abandoned or deprecated |


## Severity

CVE findings inherit the severity from the OSV database (`CRITICAL` → `critical`, `HIGH` → `high`, `MODERATE`/`MEDIUM` → `medium`, `LOW` → `low`). Unknown OSV severities default to `high`.

Abandoned and deprecated findings are always `medium`.

Only CVE findings are filtered by `minCveSeverity` - abandoned and deprecated findings always appear when their respective checks are enabled.


## Prerequisites

OSV-Scanner must be installed and available in the PATH of the Layne worker process. Install it from [https://google.github.io/osv-scanner/](https://google.github.io/osv-scanner/). If it is absent, CVE scanning is skipped with a `[dep-doctor] osv-scanner not found in PATH` warning; registry health checks still run.


## Configuration

```json
{
  "owner/repo": {
    "depDoctor": {
      "enabled": true
    }
  }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Must be `true` to enable Dep Doctor for this repo |
| `minCveSeverity` | string | `"high"` | Minimum CVE severity to report. One of `"critical"`, `"high"`, `"medium"`, `"low"`, `"info"`. CVEs below this threshold are dropped |
| `checkAbandoned` | boolean | `true` | Flag newly-added packages with no release in `abandonedDays` days |
| `abandonedDays` | number | `730` | Age threshold (in days) for considering a package abandoned. Default is 2 years |
| `checkDeprecated` | boolean | `true` | Flag newly-added packages the registry has marked as deprecated |
| `extraArgs` | string[] | `[]` | Additional CLI arguments appended to the default `osv-scanner scan --lockfile <path> --format json` invocation. Use with care - duplicate flags such as a second `--format` will produce unexpected results |

Dep Doctor scanning is disabled by default. Each repo must explicitly opt in with `enabled: true`.


## Examples

**Enable with all defaults:**
```json
{
  "acme/backend": {
    "depDoctor": {
      "enabled": true
    }
  }
}
```

**Lower the CVE threshold to also report medium-severity CVEs:**
```json
{
  "acme/backend": {
    "depDoctor": {
      "enabled": true,
      "minCveSeverity": "medium"
    }
  }
}
```

**Shorten the abandoned threshold to 1 year:**
```json
{
  "acme/backend": {
    "depDoctor": {
      "enabled": true,
      "abandonedDays": 365
    }
  }
}
```

**Disable health checks and only scan for CVEs:**
```json
{
  "acme/backend": {
    "depDoctor": {
      "enabled": true,
      "checkAbandoned": false,
      "checkDeprecated": false
    }
  }
}
```

**Enable globally for all repos:**
```json
{
  "$global": {
    "depDoctor": {
      "enabled": true,
      "minCveSeverity": "high"
    }
  }
}
```
