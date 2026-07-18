# ryu-usage

The per-agent subscription usage-metering primitive — the "usage bar" feature (à
la CodexBar / openusage). When an ACP agent that runs on its own subscription is
active in chat (Claude Code, Codex), the desktop shows that agent's rolling
rate-limit windows — the 5h "session" window and the weekly window — so the user
can see how close they are to their plan's cap.

## Role in the decomposition

An extracted Core capability crate (L0), **compiled into Core by default** and
consumed as a NON-optional path dependency — `GET /api/agents/:id/usage` is
mounted unconditionally. Read-only, poll-driven, side-effect-free. ZERO dependency
on `apps/core`.

## Key API / modules

- `fetch_usage(agent_id) -> UsageSnapshot` — the entry point.
- `UsageSnapshot` / `UsageWindow` / `UsageUnavailable` — normalized rolling
  windows and the structured "unavailable/expired" states.
- `claude` / `codex` — the two per-vendor sources.

## How the data is sourced

These agents bypass Ryu's Gateway (they talk to the vendor directly with the
user's own subscription OAuth token), so Ryu can't observe their token spend.
Instead, exactly like CodexBar/openusage, it reads the OAuth token the CLI already
stored on this machine and calls the vendor's *own* usage endpoint:

- **Codex**: `~/.codex/auth.json` → `GET chatgpt.com/backend-api/wham/usage`
  (`rate_limit.primary_window` = 5h, `secondary_window` = weekly).
- **Claude**: `~/.claude/.credentials.json` → `GET api.anthropic.com/api/oauth/usage`
  (`five_hour`, `seven_day`, `seven_day_sonnet`, `extra_usage`).

## Why it never refreshes the token

These OAuth refresh tokens are single-use (they rotate on every refresh). If Ryu
refreshed, the real CLI's next refresh would fail with `refresh_token_reused` and
**log the user out of their coding agent**. So the crate only ever *reads* the
access token and checks its expiry locally (Claude `expiresAt`; Codex JWT `exp`).
If fresh it calls the usage API; if expired it returns a structured "expired"
snapshot and lets the real CLI refresh on its own next use.

## Kernel seam (`UsageHost`)

The one kernel coupling — the Ryu-isolated, profile/relocation-aware `CODEX_HOME`
(`~/.ryu` data dir) — inverts through the narrow `UsageHost` trait installed at
boot via `set_global_host`.

## Placement

Reading an agent's own vendor usage windows is *what runs* (observing the active
agent) → Core. Later it feeds the Gateway's budget cross-tier picture.
