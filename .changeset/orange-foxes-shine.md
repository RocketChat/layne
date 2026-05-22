---
"layne": patch
---

fix(semgrep): capture end.line so multi-line findings span the full annotation range

Semgrep emits both `start.line` and `end.line` in its JSON output, but
the adapter only read `start.line` and left `startLine`/`endLine` unset.
Every Semgrep annotation therefore collapsed to a single line even for
rules that match multi-line constructs (e.g. multi-line function calls,
object literals, imports). Added `end?: { line: number }` to the raw
result interface and populate `startLine`/`endLine` in `toFinding`.
Falls back to `startLine` when `end` is absent.
