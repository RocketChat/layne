---
"layne": major
---

Replace Pi Agent with Spectre and add Dep Doctor scanner.

- **Spectre** replaces Pi Agent as the multi-provider LLM malicious-intent scanner. It makes a single direct LLM call per file (no agent session) and supports Anthropic, OpenAI, Google, Mistral, and Amazon Bedrock via `@mariozechner/pi-ai`. Configurable file cap, diff line cap, min severity, skip paths/extensions, and concurrency.
- **Dep Doctor** is a new dependency health scanner that fires when a lockfile changes. It detects newly-added packages with known CVEs (via OSV-Scanner), abandoned packages, and deprecated packages. Supports npm, PyPI, and Go lockfiles.
- PR comments now use GitHub alert blocks (`[!CAUTION]` / `[!WARNING]`) with a severity-sorted findings table linking directly to the affected file and line. The `{{findings}}` and `{{severitySummary}}` template variables are now available for custom templates.
- `Dockerfile` now installs `osv-scanner` alongside trufflehog and semgrep.
