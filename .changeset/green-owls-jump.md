---
"layne": patch
---

fix(config-validator): accept scanner keys in $global and validate removeOnException label key

`KNOWN_GLOBAL_KEYS` was missing `semgrep`, `trufflehog`, `claude`, and
`piAgent`, so using `$global.semgrep` (functional since the previous
config-inheritance fix) would cause `npm run validate-config` to report
an unknown key error. Added all four scanner keys and wired their
respective validators (`validateScanner`, `validateClaude`,
`validatePiAgent`) inside `validateGlobal`.

`validateLabels` was also missing `removeOnException` from its checked
key list, even though the worker reads and applies it. The key is now
validated alongside the other five label keys.
