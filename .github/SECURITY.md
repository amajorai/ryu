# Security Policy

Ryu runs untrusted LLM-driven agents that can execute code, run shell commands, spawn
subprocesses, and make network calls. This document states our trust model honestly, names the
boundaries we actually enforce, and is explicit about which defenses are real containment versus
best-effort accident prevention.

## Reporting a vulnerability

Report security issues privately to **`security@ryuhq.com`**. Do not open a public issue for a
suspected vulnerability.

Please include:

- The affected file or mechanism (e.g. `tool_exec/deno_backend.rs`, the SSRF guard, env-scrub).
- A minimal reproduction or proof of concept.
- The impact: what boundary is crossed and what an adversary gains.

We aim to acknowledge a report within a few business days and to keep you updated as we triage and
fix. Please give us reasonable time to ship a fix before any public disclosure.

## Trust model

- The **LLM / agent is untrusted.** Assume it is adversarial: it will try to run destructive
  commands, exfiltrate secrets, reach internal/metadata endpoints, escape the sandbox, and probe
  around pattern-based filters.
- The **operator and the Core process are trusted.** Core makes privileged calls on the agent's
  behalf; the agent never holds the keys directly.
- **Containment is the OS and the sandbox process boundary, not in-process heuristics.** A pattern
  matcher running inside the same trust domain as the thing it inspects is not a wall. A determined
  model can rephrase around it.

## Real boundaries

These are the three places where Ryu actually contains an adversarial agent:

1. **Deny-by-default code-exec sandbox.** The always-on Deno backend spawns `deno run` with zero
   `--allow-*` flags plus `--no-prompt`: no network, no filesystem, no env, and any attempt fails
   instead of prompting (`apps/core/src/tool_exec/deno_backend.rs`). The optional wasmtime/WASI
   sandbox (feature `sandbox-wasmtime`) gives the same deny-by-default posture
   (`apps/core/src/sandbox/mod.rs`).
2. **`RYU_TOKEN` + loopback-default bind + fail-closed remote/mesh auth.** Core binds
   `127.0.0.1:7980` by default. If the mesh is enabled or the bind is non-loopback and no strong
   `RYU_TOKEN` is set, Core **refuses to start** (`enforce_remote_auth` in
   `apps/core/src/server/mod.rs`). `--bind=0.0.0.0` cannot bypass it.
3. **Per-agent tool allowlists.** `allowed_tools` scopes which tools an agent may call, enforced
   in-process for least privilege.

## Layered defenses and honest limits

The command scanner, output redaction/DLP, the firewall, and env-scrub reduce blast radius and
stop honest mistakes. They are **not** containment: a determined adversarial model can probe around
pattern-based heuristics. Treat them as seat belts, not as the wall.

## In scope vs out of scope

**In scope** (please report):

- Escape from declared isolation: sandbox or process escape from the Deno/WASI backend.
- Tool-allowlist bypass: invoking a tool an agent was not granted.
- Credential exfiltration via env-scrub bugs.
- Auth bypass or fail-open in remote/mesh binding (reachable off-box without a valid `RYU_TOKEN`).
- SSRF guard bypass: reaching loopback, private, link-local, or cloud-metadata targets.
- DLP/redaction bypass that leaks a real secret through an output path that should redact it.

**Out of scope** (by design, not a containment boundary):

- Heuristic-pattern bypass of the command scanner. It is accident prevention, not a wall.
- Prompt injection **without** a chained boundary violation.
- Third-party skill or plugin malice. Operator review before install is the boundary.
- Social-engineering the operator into approving an action. The operator is trusted.

## Deployment hardening checklist

- Run Core as a **non-root** user.
- Set a strong, random `RYU_TOKEN` **before** exposing Core beyond loopback.
- Never bind `0.0.0.0` without auth.
- Lock down per-agent tool and channel allowlists to the minimum each agent needs.
- Review third-party skills and plugins before installing them.
- Keep `RYU_ALLOW_GATEWAY_FALLBACK` **unset** in production (default-deny when the gateway is
  unreachable).
- Set `RYU_EXEC_APPROVAL_MODE=manual` for untrusted workloads.
