// apps/desktop/src/lib/api/agent-egress-constants.ts
//
// Split out of `agent-egress.ts`; import from there. See that module's header.

import { CORE_LOCAL_ENGINES } from "./local-engines.ts";

/**
 * Local inference engines (Core's `LOCAL_ENGINES`, mirrored in
 * `local-engines.ts`). An agent bound to one of these resolves to
 * `AgentRoute::LocalEngine` — a loopback URL on this machine, which never
 * reaches the gateway *and* never reaches a provider. Reporting it as
 * "not governed" alongside a Claude Code that is shipping tokens to Anthropic
 * would be the same word for two very different facts, so it gets its own state.
 */
export const LOCAL_ENGINES: ReadonlySet<string> = new Set(CORE_LOCAL_ENGINES);

/** Registry ids Core routes through a dedicated, format-specific mechanism. */
export const CLAUDE_ID = "acp:claude";
export const CODEX_ID = "acp:codex";

/**
 * Where the flagship's routing is actually changed. Named in the row because
 * the Ryu row is the only one with no switch AND the only family that is on by
 * default — a status with nowhere to go would be the dead end this whole
 * surface exists to remove.
 */
export const PI_POINTER =
	"Which way it goes is decided by the provider you pick in the Ryu agent's model settings: the Ryu-managed provider is routed, your own provider key is not.";

/**
 * The timing caveat, per family. WHY it has to exist:
 *
 * Every mechanism below injects its redirect into the agent's SPAWN COMMAND —
 * `ANTHROPIC_BASE_URL` (`acp::claude_gateway_cmd`), `OPENAI_BASE_URL` +
 * `OPENAI_API_KEY` (`acp::openai_gateway_cmd`, and the same pair inline in
 * `ryu_agent_route`), or an isolated `CODEX_HOME` (`acp::codex_acp_gateway_cmd`).
 * All four return a *different command string*; none of them signals a live
 * process. So a subprocess that is already running was spawned with the old
 * environment, and there is nothing Core could send that would make it re-read
 * (`adapters/acp.rs` says as much about the managed Pi's extension table: "there
 * is nothing to send that would make a running Pi re-read"). The moment the
 * preference write returns, the row is SAVED — it is not yet in force — and a
 * badge that reports the new state as the current one is precisely the "status
 * reporting healthy for a dead thing" this surface exists to delete.
 *
 * What this is NOT is "go and restart something". `agent_route` is resolved per
 * turn (`adapters/mod.rs`, in the chat path), and the ACP pool is keyed on the
 * resolved spawn command — `{conversation}\u{1}{agent}\u{1}{spawn_cmd}\u{1}{cwd}`
 * in `spawn_acp_task` — so the changed command MISSES the warm instance and Core
 * spawns a fresh one on that chat's next message. The stale window is an
 * in-flight turn, not a session. That is exactly why the wording is the passive
 * "the next time X starts" rather than an instruction to the user: an imperative
 * would trade one inaccuracy for another.
 *
 * The three strings are COPIED VERBATIM from
 * `packages/blocks/src/desktop/agent-edit.tsx`, the other UI over these same
 * three preferences, and `agent-egress.test.ts` asserts each still appears there.
 * Two surfaces describing one mechanism in two phrasings is how a reader
 * concludes they are two mechanisms.
 */
export const TAKES_EFFECT_CLAUDE =
	"Takes effect the next time Claude Code starts.";
export const TAKES_EFFECT_CODEX = "Takes effect the next time Codex starts.";
export const TAKES_EFFECT_AGENT =
	"Takes effect the next time the agent starts.";

/**
 * The tool bridge's timing caveat, which is deliberately NOT
 * {@link TAKES_EFFECT_AGENT} — the two layers become current at genuinely
 * different moments, and reusing the egress sentence would be a comfortable lie.
 *
 * Egress is injected into the SPAWN COMMAND, and the ACP pool is keyed on that
 * command (`{conversation}\u{1}{agent}\u{1}{spawn_cmd}\u{1}{cwd}`), so changing it
 * MISSES the warm instance and the chat's next message respawns with the new
 * value — "the next time the agent starts" is accurate and near-immediate.
 *
 * The bridge changes NOTHING about the spawn command. `run_acp_instance` reads
 * `acp_tool_bridge_enabled` once, when it builds the session, and the pool key is
 * unchanged — so a chat with a live instance keeps whatever bridge it was built
 * with. It is dropped only when the instance closes: `ACP_IDLE_TTL` is 600s and
 * `spawn_acp_task` does `pool.retain(|_, turns| !turns.is_closed())`. A chat you
 * are not currently in, and every new chat, gets the new value at once.
 *
 * Saying "restart the agent" here would be advice the user cannot act on — there
 * is no restart button for a pooled ACP instance — so the sentence describes what
 * happens instead of demanding something.
 */
export const TAKES_EFFECT_TOOLS =
	"Applies to new chats right away. A chat you are already in keeps its current tools until it has been idle about ten minutes.";
