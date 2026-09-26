# Dep Doctor

Dep Doctor determines new findings by comparing resolved dependency/version pairs
against the merge base. In `diff_only` mode these findings remain reportable when
only the version changes, even if the package-name annotation line is unchanged.

<div style={{textAlign: 'center'}}>
  <img src="/img/dep-doctor.png" alt="Dep Doctor" width="160" />
</div>

Dep Doctor is a dependency health scanner that fires when a PR changes a lockfile. It checks **new package/version pairs**: newly added packages and upgrades to versions that were not present at the merge base. Unchanged package versions are ignored. This keeps findings actionable because the PR introduced the version being assessed.

It runs three checks:

1. **Known-vulnerability detection** via [OSV-Scanner](https://google.github.io/osv-scanner/) - scans the lockfile against the [OSV](https://osv.dev) database and reports identifiers such as CVEs and GitHub Security Advisories.
2. **Abandoned packages** - queries the npm or PyPI registry API and flags packages whose last published version is older than `abandonedDays` (default: 2 years).
3. **Deprecated packages** - flags packages the registry has explicitly marked as deprecated (npm `deprecated` field, PyPI `Development Status :: 7 - Inactive` classifier).

Dep Doctor is **disabled by default** and must be opted in per repo. OSV-Scanner must be installed in the PATH of the worker process. If it is missing, known-vulnerability coverage is incomplete; registry health checks can still return valid findings.


## What it detects

- **Known vulnerabilities on introduced versions** - a package/version pair added or upgraded by the PR that has an OSV vulnerability at or above `minCveSeverity`.
- **Abandoned packages** - an introduced package version whose package has not published a release in `abandonedDays` days.
- **Deprecated packages** - an introduced package version that the registry has officially marked as deprecated.

Dep Doctor does not report an unchanged package/version pair that was already in the lockfile before the PR. Upgrading a pre-existing package creates a new pair and is checked.


## How Layne runs it

1. The PR's changed files are scanned for known lockfile names. If none changed, Dep Doctor exits immediately. Changed lockfiles up to `maxLockfileSizeKb` are admitted; the default is 4096 KiB (4 MiB).
2. For each changed lockfile, Layne fetches the **merge-base version** of the lockfile via `git show`. This establishes which packages already existed before the PR.
3. OSV-Scanner is run against the head lockfile. Vulnerable package/version pairs are cross-referenced against the merge-base set; only pairs absent at merge base generate findings. Vulnerabilities below `minCveSeverity` are dropped.
4. The head and merge-base lockfiles are parsed directly to extract all resolved packages. Introduced package/version pairs are sent in batches of 5 to the npm or PyPI registry API for health checks. Go packages are not health-checked (Go's module proxy does not expose registry health metadata).
5. All findings (known vulnerabilities + health) are returned for annotation.

If the lockfile does not exist at the merge base because the PR created it, all packages in the head lockfile are treated as new. An operational failure while reading an existing baseline is different: the lockfile produces no findings and Dep Doctor is marked incomplete, avoiding false "new dependency" findings.

Unreadable, malformed, unsupported-version, or size-excluded lockfiles, baseline Git failures, OSV-Scanner failures or invalid output, and registry request failures make Dep Doctor incomplete. A failed merge-base parse never causes every head package to be treated as new. Valid vulnerability or health findings from work that did complete are retained. Blocking findings still produce `failure`; otherwise incomplete coverage produces a `neutral` Check Run. Detailed failures remain in logs, while summaries use stable reason codes.


## Supported lockfiles

| Lockfile | Ecosystem | Vulnerability scan | Abandoned | Deprecated |
|---|---|---|---|---|
| `package-lock.json` | npm | Yes | Yes | Yes |
| `yarn.lock` | npm | Yes | Yes | Yes |
| `pnpm-lock.yaml` | npm | Yes | Yes | Yes |
| `requirements.txt` | PyPI | Yes | Yes | Yes |
| `Pipfile.lock` | PyPI | Yes | Yes | Yes |
| `poetry.lock` | PyPI | Yes | Yes | Yes |
| `uv.lock` | PyPI | Yes | Yes | Yes |
| `go.sum` | Go | Yes | No | No |

Health inventory parsing supports package-lock versions 1-3, Yarn Classic and Berry, pnpm lock versions 5.3, 5.4, 6.0, and 9.0, Pipfile spec 6, Poetry lock versions 1.1, 2.0, and 2.1, and uv schema version 1. `requirements.txt` health checks cover exact `==`/`===` pins. Unknown future lockfile versions are reported as incomplete instead of being interpreted as empty.

Health checks cover all introduced resolved package/version pairs, including transitive and development dependencies. Duplicate pairs are queried once per scan. npm names are compared case-insensitively and PyPI names use PEP 503 normalization, so spelling differences such as `foo_bar` and `foo-bar` do not create false upgrades.

Explicit Git, URL, path, workspace, editable, and private-registry entries are excluded from public npm/PyPI registry lookups. Lockfiles do not always retain enough source information to identify an implicit private npm registry; configure health checks accordingly for repositories whose lockfile omits registry origins.


## Rule IDs

| Rule ID | Description |
|---|---|
| `<OSV vulnerability ID>` | An introduced package version has the named vulnerability. Examples: `CVE-2024-12345`, `GHSA-xxxx-yyyy-zzzz` |
| `abandoned/deprecated` | An introduced package version is abandoned or deprecated |


## Severity

Known-vulnerability findings inherit the severity from the OSV database (`CRITICAL` → `critical`, `HIGH` → `high`, `MODERATE`/`MEDIUM` → `medium`, `LOW` → `low`). When that label is absent, Layne derives severity from a standard numeric or CVSS v3 OSV score. Unknown OSV severities default to `high`.

Abandoned and deprecated findings are always `medium`.

Only known-vulnerability findings are filtered by `minCveSeverity` - abandoned and deprecated findings always appear when their respective checks are enabled.


## Prerequisites

OSV-Scanner must be installed and available in the PATH of the Layne worker process. Install it from [https://google.github.io/osv-scanner/](https://google.github.io/osv-scanner/). If it is absent, Layne logs `[dep-doctor] osv-scanner not found in PATH`; registry health checks still run, but the adapter result is incomplete.


## Configuration

```json
{
  "owner/repo": {
    "maxLockfileSizeKb": 4096,
    "depDoctor": {
      "enabled": true
    }
  }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Must be `true` to enable Dep Doctor for this repo |
| `minCveSeverity` | string | `"high"` | Minimum known-vulnerability severity to report. One of `"critical"`, `"high"`, `"medium"`, `"low"`, `"info"`. Lower-severity OSV findings are dropped |
| `checkAbandoned` | boolean | `true` | Flag introduced package versions whose package has no release in `abandonedDays` days |
| `abandonedDays` | number | `730` | Age threshold (in days) for considering a package abandoned. Default is 2 years |
| `checkDeprecated` | boolean | `true` | Flag introduced package versions the registry has marked as deprecated |
| `extraArgs` | string[] | `[]` | Additional CLI arguments appended to the default `osv-scanner scan --lockfile <path> --format json` invocation. Use with care - duplicate flags such as a second `--format` will produce unexpected results |

Dep Doctor scanning is disabled by default. Each repo must explicitly opt in with `enabled: true`.

`maxLockfileSizeKb` is a top-level scan option rather than a `depDoctor` option. It defaults to `4096` KiB and can be overridden globally or per repository. Lockfiles above it make Dep Doctor incomplete; ordinary source files continue to use `maxFileSizeKb`, which defaults to `1024` KiB.


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

**Lower the vulnerability threshold to also report medium-severity OSV findings:**
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

**Disable health checks and only scan for known vulnerabilities:**
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
