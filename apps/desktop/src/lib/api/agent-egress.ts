// apps/desktop/src/lib/api/agent-egress.ts
//
// ONE honest answer to "is this agent's model traffic governed?", per installed
// agent.
//
// ── Why this file exists ──────────────────────────────────────────────────────
// Governing an ACP agent has four independent layers. Layer 1 — the model call
// itself traversing the Ryu gateway, so the firewall/DLP, the spend budget and
// the audit log see it — is NOT one setting. It is decided by four different
// mechanisms with different defaults, and until this module there was no
// place that showed the combined answer:
//
//   flagship `ryu`  → `apps/core/src/pi_config`   — gateway-routed unless the
//                     active Pi provider is a BYOK one. Default ON (a fresh
//                     node has no `x-ryu-routing` key and `is_gateway_routing()`
//                     treats anything but `"direct"` as gateway).
//   `acp:claude`    → `apps/core/src/claude_config` — governed by default; an
//                     explicit preference opts out to direct egress.
//   `acp:codex`     → `apps/core/src/codex_config`  — governed by default; an
//                     explicit preference opts out to direct egress.
//   everything else → `apps/core/src/agent_routing` — a per-agent JSON map read
//                     with a governed default; explicit false opts out.
//
// An agent with layer 1 off sends its model calls straight to the provider:
// unmetered, unfiltered, absent from the audit log. That is a legitimate choice
// (it is how you keep a subscription agent entirely outside Ryu egress) — but it
// is a *choice*, and it was invisible.
//
// ── Why the answer is not a boolean ───────────────────────────────────────────
// Core cannot redirect an agent it has no hook into. `AcpAgentEntry.gateway_bypass`
// is Core's own machine-readable declaration of exactly that ("agent does not
// honour OPENAI_BASE_URL — provider calls bypass the local gateway", see the
// `tracing::debug!` in `adapters/acp.rs`), and it is served on
// `GET /api/agents/catalog`. For those agents the generic `agent-gateway-routing`
// preference is writable but INERT — Core's own module doc calls it "a genuine
// no-op". Rendering a switch there would be a settable value that cannot take
// effect, and rendering "governed" after someone flipped it would be a status
// reporting healthy for a dead thing. So `gateway_bypass` agents get no control
// and an explicit "Ryu cannot route this one" state instead of a false negative.
//
// ── Replaced `src/lib/agent-gateway.ts`, which is now DELETED ─────────────────
// `apps/desktop/src/lib/agent-gateway.ts` and `hooks/useAgentGatewayGovernance.ts`
// were a committed earlier attempt at the same mapping that NOTHING consumed —
// the hook was the only importer of the lib, and no component imported the hook.
// Both are gone; this module is the single source of truth. They are recorded
// here so the pair is not reconstructed from memory, because their
// `isAgentGatewayGoverned` carried the two defects this module exists to avoid:
//   1. it never read `gateway_bypass`, so a stale `agent-gateway-routing` entry
//      made it return `true` for an agent Core cannot route at all;
//   2. it had no local-engine state, so an agent running a model on this laptop
//      was reported the same as one streaming prompts to a provider unfiltered.
// Leaving a wrong-but-dead mapping next to a correct one is not neutral: the next
// person wiring a badge picks whichever they find first. Use `classifyAgentEgress`.
//
// ── Scope: TWO layers, and they must never fuse back into one ─────────────────
// This module now describes layer 1 (MODEL EGRESS) *and* layer 3 (the MCP TOOL
// BRIDGE), as two independent fields on every row. It still says nothing about:
//   layer 2 — the command-approval scan at the ACP `request_permission` seam,
//             which is node-wide and armed by default (`exec-approval-mode`);
//   layer 4 — plugin turn hooks.
// The UI that renders these rows must say so.
//
// Layer 3 is here because until `agent_routing`'s split it was NOT separable:
// ONE preference (`agent-gateway-routing`) gated both the base-URL swap and
// whether `build_ryu_mcp_server` was injected into the ACP session. Their risk
// profiles are different — egress moves a subscription credential and the billing
// path (hence a visible direct-egress opt-out), while the bridge offers only the tool allowlist
// the user already configured for that agent and re-checks it on every call
// (hence ON by default). Conflated, declining the credential swap ALSO removed every
// Ryu tool, which is why a freshly installed ACP agent could not do anything.
//
// So the invariant this file is responsible for, in code and in copy: **no field,
// badge, count or word here may cover both layers at once.** `governed` is egress
// and only egress; {@link AgentEgress.tools} is the bridge and only the bridge.
// The moment one "Governed" badge stands for both, the bug is back — this time in
// the UI, where it is harder to see than it was in Rust.

import {
	type AgentCatalogEntry,
	type AgentSummary,
	fetchAgent,
	fetchAgentCatalog,
	fetchAgents,
} from "./agents.ts";
import type { ApiTarget } from "./client.ts";
import { fetchPiConfig } from "./pi-config.ts";
import {
	DEFAULT_AGENT_GATEWAY_ROUTING,
	DEFAULT_AGENT_TOOL_BRIDGE,
	getAgentGatewayRoutingMap,
	getAgentToolBridgeMap,
	getClaudeGatewayRouting,
	getCodexGatewayRouting,
	setAgentGatewayRouting,
	setAgentToolBridge,
	setAgentToolBridgeMany,
	setClaudeGatewayRouting,
	setCodexGatewayRouting,
} from "./preferences.ts";

/**
 * Local inference engines, mirroring Core's `LOCAL_ENGINES`
 * (`apps/core/src/sidecar/active_engine.rs`). An agent bound to one of these
 * resolves to `AgentRoute::LocalEngine` — a loopback URL on this machine, which
 * never reaches the gateway *and* never reaches a provider. Reporting it as
 * "not governed" alongside a Claude Code that is shipping tokens to Anthropic
 * would be the same word for two very different facts, so it gets its own state.
 *
 * Deliberately NOT reusing `inference.ts`'s `LOCAL_ENGINES`: that set is the
 * narrower "engines whose endpoint accepts the non-standard sampler fields"
 * (it omits mlx/omlx/apfel/docker-model-runner), and it strips an `acp:` prefix
 * that Core's routing check does not. Keep this list in sync with Core's.
 */
const LOCAL_ENGINES: ReadonlySet<string> = new Set([
	"llamacpp",
	"ollama",
	"vllm",
	"sglang",
	"mlx",
	"mlx-vlm",
	"mlx-serve",
	"omlx",
	"docker-model-runner",
	"apfel",
	"mesh-llm",
]);

/** Registry ids Core routes through a dedicated, format-specific mechanism. */
const CLAUDE_ID = "acp:claude";
const CODEX_ID = "acp:codex";

/**
 * Where the flagship's routing is actually changed. Named in the row because
 * the Ryu row is the only one with no switch AND the only family that is on by
 * default — a status with nowhere to go would be the dead end this whole
 * surface exists to remove.
 */
const PI_POINTER =
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
const TAKES_EFFECT_CLAUDE = "Takes effect the next time Claude Code starts.";
const TAKES_EFFECT_CODEX = "Takes effect the next time Codex starts.";
const TAKES_EFFECT_AGENT = "Takes effect the next time the agent starts.";

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
const TAKES_EFFECT_TOOLS =
	"Applies to new chats right away. A chat you are already in keeps its current tools until it has been idle about ten minutes.";

/** How Core would put this agent's model calls through the gateway, if at all. */
export type EgressMechanism =
	/** Flagship `ryu`: governed iff the managed Pi's active provider is the
	 *  gateway/managed one. Not a boolean — see {@link AgentEgress.control}. */
	| "pi-provider"
	/** `acp:claude`: `ANTHROPIC_BASE_URL` → the gateway passthrough proxy. */
	| "anthropic-passthrough"
	/** `acp:codex`: an isolated `CODEX_HOME` → the gateway passthrough proxy. */
	| "codex-passthrough"
	/** Generic `OPENAI_BASE_URL` + `OPENAI_API_KEY` injection at spawn. */
	| "openai-base-url"
	/** An OpenAI-compat registry agent: Core forwards via the gateway always. */
	| "gateway-forward"
	/** A local inference engine — nothing leaves this device. */
	| "local-engine"
	/** Core has no hook into this agent's protocol (`gateway_bypass`). */
	| "unroutable"
	/** Core cannot resolve this agent's engine at all (a chat with it errors). */
	| "unresolved";

/** The preference a row can write. `null` when the row has nothing to toggle. */
export type EgressControl =
	| { agentId: string; kind: "agent" }
	| { kind: "claude" }
	| { kind: "codex" };

// ── Layer 3: the MCP tool bridge ─────────────────────────────────────────────
//
// Core's decision is `acp_tool_bridge_enabled(spawn_cmd, agent_id)` =
// `acp_bridge_supported(spawn_cmd) && is_tool_bridge_enabled(agent_id)`.
// TWO terms, and the desktop must mirror both or it will print a preference value
// over an agent Core will never bridge.
//
// ── Why this mirrors rather than reads Core's own answer ─────────────────────
// Core DOES classify this itself: `acp::RyuToolAccess` (`bridge` | `pi-extension`
// | `none`) is served as `ryuToolAccess`. The three cases are the same three
// {@link ToolBridgeMechanism} names an ACP agent can take here, deliberately —
// they were derived from the same two spawn-command substrings.
//
// It is not consumed here because of WHERE it is served: `GET /api/agents/:id/
// acp-config`, whose handler calls `probe_acp_config`, which SPAWNS the agent and
// opens a throwaway ACP session to read its advertisement. That is a subprocess
// per agent — acceptable for one agent's editor, not for a settings list that
// renders every installed agent at once. So this file reconstructs the pure part
// (`ryu_tool_access` is explicitly "derived from the spawn command alone") from
// catalog data already in hand, and the four mirror tests below pin it to Core.
//
// If Core ever puts `ryuToolAccess` on the cheap `GET /api/agents/catalog`, delete
// `runsPiAcp` and read the field — a mirror living next to a served answer is the
// same drift trap this module's header records about the deleted
// `src/lib/agent-gateway.ts`.

/** How (or whether) Ryu's tools reach this agent. */
export type ToolBridgeMechanism =
	/** ACP session + Core's in-process MCP server. The only settable case. */
	| "mcp-bridge"
	/** The flagship `ryu`: no bridge, but the `ryu-mcp` Pi extension instead. */
	| "pi-extension"
	/** A pi-acp agent that is NOT the managed flagship — neither path reaches it. */
	| "pi-no-bridge"
	/** Not an ACP session at all, so this switch has nothing to act on. */
	| "not-acp";

export interface AgentToolBridge {
	/** The tool-bridge preference this row can write, or `null` when inert. */
	control: { agentId: string } | null;
	/** One sentence naming how tools do or do not reach this agent. */
	detail: string;
	/**
	 * Whether Ryu's tools reach this agent. `null` only where the question is not
	 * this switch's to answer (a non-ACP route) — never render `null` as "no".
	 *
	 * For a `mcp-bridge` row this is the preference, and a MISSING entry is `true`
	 * because Core's `is_tool_bridge_enabled` is `unwrap_or(true)`. That is a
	 * mirrored fact, not an optimistic default: see the contract block above
	 * {@link AGENT_TOOL_BRIDGE_PREF_KEY} in `preferences.ts`.
	 */
	enabled: boolean | null;
	mechanism: ToolBridgeMechanism;
	/** {@link TAKES_EFFECT_TOOLS}, or `null` on a row with nothing to wait for. */
	takesEffect: string | null;
}

/**
 * Mirror of Core's `acp_bridge_supported`: `!spawn_cmd.contains("pi-acp")`.
 *
 * The desktop never sees a spawn command, so this reconstructs the same set from
 * catalog data it already fetches. Three ways an agent ends up running `pi-acp`:
 *
 *   1. the flagship `ryu` — `AcpAgentEntry { id: "ryu", transport: Acp { spawn_cmd:
 *      pi_acp_cmd() } }`, wrapped by `ryu_pi_acp_cmd` at routing time;
 *   2. `acp:pi` — the same `pi_acp_cmd()`, and the only registry entry carrying
 *      `registry_id: Some("pi-acp")`;
 *   3. a BYO `acp-exec:<command>` whose command literally runs pi-acp, which Core
 *      matches by the same substring test.
 *
 * **This is NOT `gatewayBypass`, and the two sets genuinely differ** — mixing them
 * up is the single easiest way to get this wrong. `acp:gemini` is
 * `gateway_bypass: true` (Core cannot redirect its model calls) yet takes the tool
 * bridge fine; `acp:pi` is `gateway_bypass: false` (its egress IS settable) yet can
 * never take the bridge. Neither field substitutes for the other.
 */
function runsPiAcp(
	agentId: string,
	engine: string,
	flagship: boolean,
	entry: AgentCatalogEntry | null
): boolean {
	if (flagship || agentId === "ryu") {
		return true;
	}
	if (engine.startsWith("acp-exec:")) {
		return engine.includes("pi-acp");
	}
	// `entry.id === "ryu"` matters and is NOT covered by the flagship check above:
	// the agent editor offers every installed agent as an engine, so a CUSTOM agent
	// can be bound to `engine: "ryu"`. Its id is not `"ryu"` and Core sets
	// `recommended` only on the registry entry, so `flagship` is false — yet
	// `agent_route` matches `agent_id == "ryu"` on the AGENT id, which a custom
	// agent fails, dropping it to the registry entry whose transport is the bare
	// `pi_acp_cmd()`. That command carries `pi-acp` and no `PI_CODING_AGENT_DIR`,
	// which is Core's `RyuToolAccess::None`: no bridge and no extension either.
	// Without this clause the row would offer a switch Core's transport guard can
	// never honour — the dead control this module refuses everywhere else.
	return (
		entry?.registryId === "pi-acp" ||
		entry?.id === "acp:pi" ||
		entry?.id === "ryu"
	);
}

/**
 * The stored tool-bridge value for an agent, folding in Core's ON default.
 *
 * Split out and named because the default is the whole fix: a missing entry is
 * the state EVERY agent is in until someone touches this panel, so getting it
 * wrong here would mis-report the common case rather than an edge one.
 */
function storedToolBridge(
	agentId: string,
	tools: Record<string, boolean>
): boolean {
	const stored = tools[agentId];
	return typeof stored === "boolean" ? stored : DEFAULT_AGENT_TOOL_BRIDGE;
}

/**
 * Classify how Ryu's tools reach one agent — the layer-3 half of a row.
 *
 * Pure, and takes the already-resolved catalog `entry` so it cannot disagree with
 * {@link classifyAgentEgress} about which registry entry an engine resolved to.
 */
export function classifyToolBridge(
	agent: EgressAgentInput,
	entry: AgentCatalogEntry | null,
	// `Pick`, not the whole `EgressPrefs`: this half must be structurally unable
	// to read an egress preference. The bug being fixed was one gate consulting
	// the other's value, so the type is where that is made impossible rather than
	// only discouraged in a comment.
	prefs: Pick<EgressPrefs, "tools">,
	egressMechanism: EgressMechanism
): AgentToolBridge {
	const engine = agent.engine?.trim() || agent.id;
	const flagship = agent.flagship || agent.id === "ryu";

	if (runsPiAcp(agent.id, engine, flagship, entry)) {
		// The flagship still HAS Ryu's tools — via a different mechanism entirely.
		// `pi_config::ensure_pi_mcp_extension` ships `ryu-mcp.ts` into the MANAGED
		// config dir (`~/.ryu/pi-agent/extensions/`), and that extension POSTs to
		// Core's HTTP tool API. Saying "no tools" here would be false in the most
		// damaging possible place: the default agent, on every fresh install.
		if (flagship) {
			return {
				mechanism: "pi-extension",
				enabled: true,
				control: null,
				takesEffect: null,
				detail:
					"Has Ryu's tools, but not through this switch — the Ryu agent gets them from a Pi extension Ryu installs into its own config folder. There is nothing to turn on here.",
			};
		}
		// Bare `acp:pi` (and a BYO command running pi-acp) get NEITHER: pi-acp
		// advertises no MCP-server support so Core skips the bridge, and
		// `ensure_pi_mcp_extension` writes only into Ryu's managed folder — its
		// doc comment is explicit that it "never touches the user's `~/.pi`".
		// This is the answer to "why does my Pi agent ignore every Ryu tool", and
		// it has to be readable HERE, not discovered when a tool call never happens.
		return {
			mechanism: "pi-no-bridge",
			enabled: false,
			control: null,
			takesEffect: null,
			detail:
				"Ryu cannot give this one tools. Pi accepts no tool server over ACP, and the extension Ryu uses for its own agent is only installed into Ryu's managed Pi folder, not your own. Use the Ryu agent if you want Ryu's tools with Pi.",
		};
	}

	// Everything that is not an ACP session: a local engine, an SDK app, an
	// `openai_compat` registry agent Core forwards itself, or an engine Core
	// cannot resolve. None of them build an ACP session, so this preference has
	// nothing to act on — and claiming either answer would be inventing one.
	if (
		egressMechanism === "local-engine" ||
		egressMechanism === "gateway-forward" ||
		egressMechanism === "unresolved"
	) {
		return {
			mechanism: "not-acp",
			enabled: null,
			control: null,
			takesEffect: null,
			detail:
				"Not an ACP agent, so this switch does not apply — whatever tools it has are decided by how it is run, not here.",
		};
	}

	const enabled = storedToolBridge(agent.id, prefs.tools);
	return {
		mechanism: "mcp-bridge",
		enabled,
		control: { agentId: agent.id },
		takesEffect: TAKES_EFFECT_TOOLS,
		detail: enabled
			? "Ryu's tools are offered to this agent — exactly the tools its own allowlist permits, re-checked on every call."
			: "Ryu's tools are withheld from this agent. It runs with only whatever tools it brings itself.",
	};
}

export interface AgentEgress {
	agentId: string;
	/**
	 * True when Ryu's redirect is in place but only does anything if the agent's
	 * HTTP client actually honours `OPENAI_BASE_URL`. NOTE the deliberate wording:
	 * this is WHETHER the redirect works, and {@link AgentEgress.takesEffect} is
	 * WHEN it starts applying — two different caveats that render one under the
	 * other on the same row, so neither may borrow the other's verb ("takes
	 * effect") or a reader fuses them into a single vague hedge. Core cannot know that for a
	 * BYO command, so the UI must not print a bare "governed" for these.
	 */
	bestEffort: boolean;
	/** The toggle for this row, or `null` when no working toggle exists. */
	control: EgressControl | null;
	/** Why enabling the control changes how a credential flows. */
	credentialNote: string | null;
	/** One sentence naming the actual mechanism. Always shown. */
	detail: string;
	/**
	 * Whether model calls currently traverse the gateway. `null` means the
	 * question does not apply (local engine) or cannot be answered (unresolved
	 * engine) — never render `null` as "no".
	 */
	governed: boolean | null;
	mechanism: EgressMechanism;
	name: string;
	/**
	 * The one-sentence timing caveat for this row (see the `TAKES_EFFECT_*`
	 * constants), or `null` when the row's mechanism has nothing to wait for:
	 * a local engine and an unroutable agent have no redirect to apply, an
	 * unresolved engine has no known mechanism at all, and an `openai_compat`
	 * registry agent is forwarded by Core itself at request time
	 * (`AgentRoute::OpenAiCompat { via_gateway: true }`) rather than at spawn, so
	 * it is governed on the very next call with no process to restart.
	 *
	 * Non-null even on rows with no switch (the flagship): the row already points
	 * at where its control lives, and the timing applies to a change made there
	 * just the same.
	 */
	takesEffect: string | null;
	/**
	 * Layer 3 — whether Ryu's tools reach this agent, and how.
	 *
	 * A SEPARATE member on purpose: every field above it describes model egress
	 * and nothing else. `governed: false` next to `tools.enabled: true` is a
	 * perfectly ordinary row (the agent talks to its provider directly and still
	 * has Ryu's tools), and any code that folds the two into one boolean has
	 * re-created the conflation this module documents at the top.
	 */
	tools: AgentToolBridge;
}

/** The five preference reads this view is built from. */
export interface EgressPrefs {
	/** `agent-gateway-routing`: agent id → enabled. Missing ⇒ Gateway governance. */
	agents: Record<string, boolean>;
	/** `claude-gateway-routing`. Default Gateway governance. */
	claude: boolean;
	/** `codex-gateway-routing`. Default Gateway governance. */
	codex: boolean;
	/** `/api/pi-config` `routing`: `"gateway"` | `"direct"`. Default gateway. */
	piRouting: string;
	/**
	 * `agent-tool-bridge`: agent id → enabled. Missing ⇒ **ON**, the opposite of
	 * {@link EgressPrefs.agents}. Two maps, two defaults, two risk profiles — the
	 * shapes are identical, so the only thing keeping them apart is that they are
	 * different fields. Do not merge them.
	 */
	tools: Record<string, boolean>;
}

/** The per-agent facts the classifier needs, independent of how they were fetched. */
export interface EgressAgentInput {
	/**
	 * The agent's canonical engine binding — the same string Core's
	 * `resolve_binding` hands to `agent_route`. `null` falls back to the id,
	 * mirroring Core's `engine.or(agent_id)`.
	 *
	 * NOTE for callers: `GET /api/agents` STRIPS the `acp:` prefix from a
	 * built-in's `engine` (it serves `"claude"`, not `"acp:claude"`), which
	 * matches no catalog id. Pass the built-in's `id` instead — for registry
	 * built-ins the id *is* the canonical engine. {@link loadAgentEgress} does.
	 */
	engine: string | null;
	/** True only for the flagship `ryu` agent (Core sets `recommended` for it). */
	flagship: boolean;
	id: string;
	name: string;
}

/**
 * Mirror of Core's `AcpAgentRegistry::find_by_prefix`
 * (`agent_id == e.id || agent_id.starts_with(&e.id)`), scanning in registry
 * order. The order of `GET /api/agents/catalog` is the registry's declaration
 * order, so preserving the array order preserves Core's resolution.
 */
function findByPrefix(
	engine: string,
	catalog: readonly AgentCatalogEntry[]
): AgentCatalogEntry | null {
	for (const entry of catalog) {
		if (engine === entry.id || engine.startsWith(entry.id)) {
			return entry;
		}
	}
	return null;
}

/**
 * Classify one agent, layer 1 AND layer 3, mirroring the resolution order of
 * `agent_route` in `apps/core/src/sidecar/adapters/mod.rs`. Pure so the mapping
 * is testable without a node.
 *
 * ONE exported classifier for both layers rather than two the caller composes:
 * the tool-bridge half needs the SAME resolved catalog entry the egress half
 * resolved (`acp:pi` is recognised through `registryId === "pi-acp"`), and two
 * independent `findByPrefix` calls is exactly the seam where the two halves would
 * eventually answer about different agents.
 */
export function classifyAgentEgress(
	agent: EgressAgentInput,
	catalog: readonly AgentCatalogEntry[],
	prefs: EgressPrefs
): AgentEgress {
	// Resolved once, here, and threaded into both halves. The `acp-exec:`/`sdk:`
	// guard reproduces the original control flow, where those two branches
	// returned before the lookup ever ran — an `acp-exec:` engine cannot prefix-
	// match a registry id anyway, but relying on that would be relying on the
	// current registry's id shapes rather than on the order Core actually uses.
	const engineForLookup = agent.engine?.trim() || agent.id;
	const resolvedEntry =
		engineForLookup.startsWith("acp-exec:") ||
		engineForLookup.startsWith("sdk:")
			? null
			: findByPrefix(engineForLookup, catalog);
	const egress = classifyEgressLayer(agent, catalog, prefs);
	return {
		...egress,
		tools: classifyToolBridge(agent, resolvedEntry, prefs, egress.mechanism),
	};
}

/**
 * The layer-1 half. Private: callers must go through
 * {@link classifyAgentEgress}, so a row can never be built with an egress
 * verdict and no tool verdict beside it.
 */
function classifyEgressLayer(
	agent: EgressAgentInput,
	catalog: readonly AgentCatalogEntry[],
	prefs: EgressPrefs
): Omit<AgentEgress, "tools"> {
	const base = { agentId: agent.id, name: agent.name };

	// 1. The flagship. Core checks `agent_id == "ryu"` before anything else and
	//    routes it to `ryu_agent_route`, whose gateway env-injection is gated on
	//    `pi_config::is_gateway_routing()`.
	//
	//    No switch, and the copy has to say where the control IS: Core writes
	//    `x-ryu-routing` only from `apply()`, as `is_managed_or_gateway(&provider)`
	//    — so this is decided by which provider the managed Pi is set to, and
	//    "off" has no meaning until you name the provider to go direct to. A
	//    switch here would be a control Core cannot honour; a bare status with no
	//    pointer would be a dead end on the one family that is ON by default.
	if (agent.flagship || agent.id === "ryu") {
		const governed = prefs.piRouting !== "direct";
		return {
			...base,
			mechanism: "pi-provider",
			governed,
			control: null,
			bestEffort: false,
			credentialNote: null,
			takesEffect: TAKES_EFFECT_AGENT,
			detail: governed
				? `Runs Ryu's managed Pi with the gateway on top — every model call is filtered, budgeted and logged. ${PI_POINTER}`
				: `Ryu's managed Pi is set to a direct provider, so its model calls go straight to that provider. ${PI_POINTER}`,
		};
	}

	// Core: `let engine = engine.or(agent_id)?` then `route_id = agent_id`.
	const engine = agent.engine?.trim() || agent.id;

	// 2. BYO `acp-exec:<command>` — the one case the generic toggle was built for.
	const byoCommand = engine.startsWith("acp-exec:")
		? engine.slice("acp-exec:".length).trim()
		: "";
	if (byoCommand !== "") {
		const governed = prefs.agents[agent.id] ?? DEFAULT_AGENT_GATEWAY_ROUTING;
		return {
			...base,
			mechanism: "openai-base-url",
			governed,
			control: { kind: "agent", agentId: agent.id },
			bestEffort: true,
			credentialNote: null,
			takesEffect: TAKES_EFFECT_AGENT,
			detail: governed
				? "Ryu points this command at the gateway with OPENAI_BASE_URL. It only does anything if the command's client reads that variable."
				: "Runs your command as-is — its model calls go straight to whatever provider it is configured with.",
		};
	}

	// 3. SDK apps run out of process against the loopback; nothing here reads or
	//    writes their egress, so claiming either answer would be inventing one.
	if (engine.startsWith("sdk:")) {
		return {
			...base,
			mechanism: "unresolved",
			governed: null,
			control: null,
			bestEffort: false,
			credentialNote: null,
			takesEffect: null,
			detail:
				"An SDK app. Ryu does not control its model egress from here — check the app itself.",
		};
	}

	// 4. Local inference engine — a loopback route, not provider egress.
	if (LOCAL_ENGINES.has(engine)) {
		return {
			...base,
			mechanism: "local-engine",
			governed: null,
			control: null,
			bestEffort: false,
			credentialNote: null,
			takesEffect: null,
			detail:
				"Runs a model on this device. Nothing is sent to a provider, so there is no egress to govern.",
		};
	}

	const entry = findByPrefix(engine, catalog);
	if (!entry) {
		return {
			...base,
			mechanism: "unresolved",
			governed: null,
			control: null,
			bestEffort: false,
			credentialNote: null,
			takesEffect: null,
			detail: `Ryu does not recognise the engine "${engine}", so it cannot say where this agent's model calls go (chats with it will fail).`,
		};
	}

	// 5. Claude Code — its own Anthropic-format passthrough, governed by default;
	// explicit false enables direct egress.
	if (entry.id === CLAUDE_ID) {
		return {
			...base,
			mechanism: "anthropic-passthrough",
			governed: prefs.claude,
			control: { kind: "claude" },
			bestEffort: false,
			credentialNote:
				"Your Claude Pro/Max sign-in is forwarded to Anthropic unchanged — Ryu adds no API key, so you stay on your subscription. The gateway does see the request.",
			takesEffect: TAKES_EFFECT_CLAUDE,
			detail: prefs.claude
				? "Routed through the gateway's Anthropic passthrough, so its model calls are filtered and logged."
				: "Talks to Anthropic directly. Its model calls are not filtered, not counted against your budget, and not in the activity log.",
		};
	}

	// 6. Codex — its own ChatGPT-login passthrough, governed by default; explicit
	// false enables direct egress.
	if (entry.id === CODEX_ID) {
		return {
			...base,
			mechanism: "codex-passthrough",
			governed: prefs.codex,
			control: { kind: "codex" },
			bestEffort: false,
			credentialNote:
				"Your ChatGPT sign-in is forwarded to OpenAI unchanged — Ryu adds no API key, so you stay on your subscription. Codex runs against a separate config folder while this is on.",
			takesEffect: TAKES_EFFECT_CODEX,
			detail: prefs.codex
				? "Routed through the gateway's Codex passthrough, so its model calls are filtered and logged."
				: "Talks to OpenAI directly. Its model calls are not filtered, not counted against your budget, and not in the activity log.",
		};
	}

	// 7. An OpenAI-compat registry agent — Core always forwards it via the
	//    gateway (`via_gateway: true`), so there is nothing to opt into.
	if (entry.transport === "openai_compat") {
		return {
			...base,
			mechanism: "gateway-forward",
			governed: true,
			control: null,
			bestEffort: false,
			credentialNote: null,
			takesEffect: null,
			detail:
				"Always goes through the gateway — this agent has no direct path to a provider.",
		};
	}

	// 8. An ACP agent Core declared unroutable. The generic preference is still
	//    writable, but Core's own doc calls the injection "a genuine no-op" for
	//    these, so offering the switch would be offering a dead control.
	if (entry.gatewayBypass) {
		return {
			...base,
			mechanism: "unroutable",
			governed: false,
			control: null,
			bestEffort: false,
			credentialNote: null,
			takesEffect: null,
			detail:
				"Ryu has no way to redirect this agent — it speaks its provider's own protocol and ignores the gateway. Its model calls always go direct.",
		};
	}

	// 9. Any remaining registry ACP agent: the generic base-URL swap applies.
	const governed = prefs.agents[agent.id] ?? DEFAULT_AGENT_GATEWAY_ROUTING;
	return {
		...base,
		mechanism: "openai-base-url",
		governed,
		control: { kind: "agent", agentId: agent.id },
		bestEffort: true,
		credentialNote: null,
		takesEffect: TAKES_EFFECT_AGENT,
		detail: governed
			? "Ryu points this agent at the gateway with OPENAI_BASE_URL. It only does anything if the agent reads that variable."
			: "Its model calls go straight to whatever provider it is configured with.",
	};
}

/** The `Badge` variants this view uses, narrowed to the four it can return. */
export type EgressBadgeVariant =
	| "default"
	| "destructive"
	| "outline"
	| "secondary";

export interface EgressBadgeDescriptor {
	label: string;
	/**
	 * True while the badge is reporting a value this panel SAVED that is not yet
	 * in force. The row must show {@link AgentEgress.takesEffect} when this is set.
	 */
	pendingStart: boolean;
	variant: EgressBadgeVariant;
}

/**
 * The status pill for one row. SIX visually distinct states, because collapsing
 * them to on/off is exactly the lie this surface exists to remove: an agent
 * running a model on this laptop and an agent streaming your prompts to
 * Anthropic unfiltered are not both "not governed" — and a preference that was
 * saved four seconds ago is not yet the state of a process that started an hour
 * ago.
 *
 * `savedTo` is the value THIS PANEL last wrote for the row, or `null` if it has
 * written nothing. It is the only in-force signal reachable from the desktop, and
 * it is a one-way one: a write we just made is definitely not in force yet for an
 * already-running instance, but its absence does NOT prove the displayed state is
 * in force (the same preference is writable from the agent editor, and Core
 * exposes no per-agent live-instance state — see the module header of
 * `AgentEgressSection.tsx` for exactly what Core would have to serve). That is why
 * the standing {@link AgentEgress.takesEffect} sentence is rendered on the row
 * whether or not this flag is set: the badge sharpens the claim in the one case we
 * can prove, and the sentence covers the rest.
 *
 * A row whose `takesEffect` is `null` has no spawn step to wait for, so a write
 * there IS the current state and the badge must not hedge — hedging everywhere is
 * how a caveat stops being read.
 */
export function describeEgressBadge(
	row: AgentEgress,
	savedTo: boolean | null = null
): EgressBadgeDescriptor {
	if (savedTo !== null && row.takesEffect !== null) {
		// Both directions hedge. Turning routing OFF is the same lie mirrored: a
		// running agent keeps going THROUGH the gateway after the switch says
		// "Straight to provider", and someone who flipped it off to keep a
		// subscription outside Ryu egress deserves to know it has not happened yet.
		return {
			label: savedTo ? "Gateway on next start" : "Direct on next start",
			variant: "outline",
			pendingStart: true,
		};
	}
	if (row.mechanism === "local-engine") {
		return {
			label: "On this device",
			variant: "secondary",
			pendingStart: false,
		};
	}
	if (row.governed === null) {
		return { label: "Unknown", variant: "outline", pendingStart: false };
	}
	if (row.governed) {
		// "Pointed at" rather than "through": Ryu sets OPENAI_BASE_URL, but it
		// cannot make a third-party binary read it.
		return row.bestEffort
			? { label: "Pointed at gateway", variant: "outline", pendingStart: false }
			: { label: "Through gateway", variant: "default", pendingStart: false };
	}
	if (row.mechanism === "unroutable") {
		return {
			label: "Can't be routed",
			variant: "outline",
			pendingStart: false,
		};
	}
	return {
		label: "Straight to provider",
		variant: "destructive",
		pendingStart: false,
	};
}

/**
 * The whole view: one row per installed agent, plus the counts worth showing.
 *
 * TWO independent partitions of the same `rows`, one per layer, and both are
 * tested on adding up. A summary line whose numbers do not add up to the list
 * beneath it is its own small dishonesty: "1 governed, 0 direct" over three rows
 * invites the reader to assume the other two were fine.
 *
 * The two partitions are never summed together and never share a word. There is
 * no combined "N agents configured" number here on purpose — that number is what
 * a reader would take as the answer, and it cannot be one, because an agent can
 * be direct-with-tools or gateway-without-tools and both are deliberate states.
 */
export interface AgentEgressView {
	/** Rows Ryu redirects but cannot guarantee (see {@link AgentEgress.bestEffort}). */
	bestEffortCount: number;
	/** Rows whose model calls reach a provider without passing the gateway. */
	directCount: number;
	/** Rows definitely going through the gateway (excludes best-effort ones). */
	governedCount: number;
	/** Rows with no provider egress to govern, or none Ryu can determine. */
	otherCount: number;
	rows: AgentEgress[];
	/** Rows with no Ryu tools: switched off, or a Pi that can never take them. */
	toolsOffCount: number;
	/** Rows Ryu's tools reach — by the bridge or, for the flagship, the extension. */
	toolsOnCount: number;
	/** Rows this switch cannot answer for (non-ACP routes). */
	toolsOtherCount: number;
}

export function summarizeAgentEgress(rows: AgentEgress[]): AgentEgressView {
	let governedCount = 0;
	let bestEffortCount = 0;
	let directCount = 0;
	let otherCount = 0;
	let toolsOnCount = 0;
	let toolsOffCount = 0;
	let toolsOtherCount = 0;
	for (const row of rows) {
		if (row.governed === true) {
			if (row.bestEffort) {
				bestEffortCount += 1;
			} else {
				governedCount += 1;
			}
		} else if (row.governed === false) {
			directCount += 1;
		} else {
			otherCount += 1;
		}
		if (row.tools.enabled === true) {
			toolsOnCount += 1;
		} else if (row.tools.enabled === false) {
			toolsOffCount += 1;
		} else {
			toolsOtherCount += 1;
		}
	}
	return {
		rows,
		governedCount,
		bestEffortCount,
		directCount,
		otherCount,
		toolsOnCount,
		toolsOffCount,
		toolsOtherCount,
	};
}

/** The status pill for a row's TOOL half. Separate function, separate words. */
export function describeToolBadge(
	row: AgentEgress,
	savedTo: boolean | null = null
): EgressBadgeDescriptor {
	// Same hedge as the egress badge and for the same reason, but the pending
	// window is different (see {@link TAKES_EFFECT_TOOLS}): a chat with a live
	// ACP instance keeps the bridge it was built with. "Pending" here means "not
	// yet in your open chats", not "not yet anywhere".
	if (savedTo !== null && row.tools.takesEffect !== null) {
		return {
			label: savedTo ? "Tools on in new chats" : "Tools off in new chats",
			variant: "outline",
			pendingStart: true,
		};
	}
	if (row.tools.enabled === null) {
		return { label: "Not applicable", variant: "outline", pendingStart: false };
	}
	if (row.tools.enabled) {
		// The flagship's tools do not come from this switch, so it does not get the
		// same pill as an agent whose bridge is on — a shared label would imply a
		// shared control, and there is no control here to find.
		return row.tools.mechanism === "pi-extension"
			? {
					label: "Tools via Pi extension",
					variant: "secondary",
					pendingStart: false,
				}
			: { label: "Ryu tools on", variant: "default", pendingStart: false };
	}
	return row.tools.mechanism === "pi-no-bridge"
		? { label: "Can't take tools", variant: "outline", pendingStart: false }
		: { label: "Ryu tools off", variant: "destructive", pendingStart: false };
}

/** Read the five preferences this view resolves against. */
export async function fetchEgressPrefs(
	target: ApiTarget
): Promise<EgressPrefs> {
	const [claude, codex, piRouting, agents, tools] = await Promise.all([
		getClaudeGatewayRouting(target),
		getCodexGatewayRouting(target),
		// A node whose managed Pi has never been configured has no settings.json;
		// Core's `is_gateway_routing()` returns true in exactly that case, so the
		// failure default must be "gateway" or a fresh node would read as direct.
		fetchPiConfig(target)
			.then((cfg) => cfg.routing)
			.catch(() => "gateway"),
		getAgentGatewayRoutingMap(target),
		getAgentToolBridgeMap(target),
	]);
	return { claude, codex, piRouting, agents, tools };
}

/**
 * The canonical engine binding for a summary row.
 *
 * `GET /api/agents` serves built-ins from the in-code registry with the `acp:`
 * prefix stripped (`"claude"`), and serves custom DB rows with `engine: null`
 * outright. Neither is what Core's router matches on, so: built-ins use their
 * id (which IS the registry id), and custom rows are re-read through
 * `GET /api/agents/:id`, whose record carries the engine the picker saved
 * (`acp:claude`, `acp-exec:<cmd>`, …).
 */
async function canonicalEngine(
	target: ApiTarget,
	agent: AgentSummary
): Promise<string | null> {
	if (agent.builtIn) {
		return agent.id;
	}
	try {
		const record = await fetchAgent(target, agent.id);
		return record.engine;
	} catch {
		// A record we cannot read is honestly unknown, not "direct".
		return null;
	}
}

/** Load every installed agent's model-egress state for a node. */
export async function loadAgentEgress(
	target: ApiTarget
): Promise<AgentEgressView> {
	const [agents, catalog, prefs] = await Promise.all([
		fetchAgents(target),
		fetchAgentCatalog(target).catch(() => [] as AgentCatalogEntry[]),
		fetchEgressPrefs(target),
	]);
	const engines = await Promise.all(
		agents.map((agent) => canonicalEngine(target, agent))
	);
	const rows = agents.map((agent, index) =>
		classifyAgentEgress(
			{
				id: agent.id,
				name: agent.name,
				engine: engines[index],
				flagship: agent.recommended,
			},
			catalog,
			prefs
		)
	);
	return summarizeAgentEgress(rows);
}

/** Write the preference behind a row's control. Returns whether it persisted. */
export function setAgentEgressGoverned(
	target: ApiTarget,
	control: EgressControl,
	enabled: boolean
): Promise<boolean> {
	switch (control.kind) {
		case "claude":
			return setClaudeGatewayRouting(target, enabled);
		case "codex":
			return setCodexGatewayRouting(target, enabled);
		default:
			return setAgentGatewayRouting(target, control.agentId, enabled);
	}
}

/** Write one row's tool-bridge preference. Returns whether it persisted. */
export function setAgentToolsEnabled(
	target: ApiTarget,
	agentId: string,
	enabled: boolean
): Promise<boolean> {
	return setAgentToolBridge(target, agentId, enabled);
}

// ── The bulk action: "give every agent Ryu's tools" ──────────────────────────
//
// ── Why it is TOOLS-ONLY, and why that is not a half-measure ─────────────────
// A one-click "configure every agent" that included egress would, on the very
// first click, re-point Claude Code's Pro/Max sign-in at the local gateway and
// move where that spend is counted — for every agent at once, from a button whose
// label says "configure". Egress remains an explicit per-agent opt-out in Core
// precisely because it is a decision per agent and per credential; a bulk control
// should not overwrite a user's existing direct-egress choice.
//
// The tools half has no such property (the bridge offers only the allowlist the
// agent already has, re-checked per call), so it is the half a bulk action may
// safely own. Egress stays exactly where it is: one row, one switch, one
// deliberate act. This is stated in the plan itself — {@link ToolBridgePlan}
// carries `egressUntouched` so the confirming UI must show it rather than
// remember to.
//
// ── Why it is a PLAN, not an apply ───────────────────────────────────────────
// `planEnableToolsForAll` computes and returns; nothing is written until
// `applyToolBridgePlan` is called with it. So the dialog above can render the
// exact per-agent list — including the ones it will NOT touch and why — and the
// user confirms a specific, enumerated change rather than a verb.

/** One agent the plan would change. */
export interface ToolBridgeChange {
	agentId: string;
	/** The value the row shows now. */
	from: boolean;
	name: string;
	/** The value the plan would write. */
	to: boolean;
}

/** One agent the plan will not touch, with the reason shown to the user. */
export interface ToolBridgeSkip {
	agentId: string;
	name: string;
	reason: string;
}

export interface ToolBridgePlan {
	/** Agents whose tool state would change. Empty ⇒ nothing to do. */
	changes: ToolBridgeChange[];
	/**
	 * Always `true`, and present so the confirming UI cannot forget to say it.
	 * A constant rather than a computed value on purpose: the day someone adds
	 * egress writes to `applyToolBridgePlan`, this field is the thing that has to
	 * be deleted, which is a review-visible act.
	 */
	egressUntouched: true;
	/** Agents deliberately left alone, each with a reason worth reading. */
	skipped: ToolBridgeSkip[];
}

/**
 * What "turn Ryu's tools on for every agent" would actually do to THIS node.
 *
 * Skips are enumerated rather than filtered away. A preview that silently omits
 * the agents it cannot help lets the user believe the click covered everything,
 * and the single most important omission — the flagship and bare `acp:pi` — is
 * exactly the one they most need to read, because it is the answer to "why does
 * my Pi agent still ignore Ryu's tools".
 */
export function planEnableToolsForAll(
	view: AgentEgressView,
	enabled = true
): ToolBridgePlan {
	const changes: ToolBridgeChange[] = [];
	const skipped: ToolBridgeSkip[] = [];
	for (const row of view.rows) {
		const { tools } = row;
		if (tools.control === null) {
			skipped.push({
				agentId: row.agentId,
				name: row.name,
				reason: skipReason(tools.mechanism),
			});
			continue;
		}
		if (tools.enabled === enabled) {
			continue;
		}
		changes.push({
			agentId: row.agentId,
			name: row.name,
			from: tools.enabled === true,
			to: enabled,
		});
	}
	return { changes, skipped, egressUntouched: true };
}

/** The one-line reason a row has no tool control, in the user's terms. */
function skipReason(mechanism: ToolBridgeMechanism): string {
	switch (mechanism) {
		case "pi-extension":
			return "Already has Ryu's tools, from a Pi extension rather than this switch.";
		case "pi-no-bridge":
			return "Cannot take Ryu's tools at all — Pi accepts no tool server, and the Ryu Pi extension is only installed for the Ryu agent.";
		default:
			return "Not an ACP agent, so there is no tool bridge to turn on.";
	}
}

/**
 * Apply a plan in ONE preference write.
 *
 * `setAgentToolBridgeMany` is a single read-merge-write. Looping the single-agent
 * setter would be a lost-update race against itself — every call reads the same
 * pre-write blob of the one shared key, so a five-agent bulk action could persist
 * one entry and silently drop four. That is a worse failure than not offering the
 * button, because the UI would report success.
 *
 * A plan with no changes writes nothing and succeeds: re-confirming a bulk action
 * that is already satisfied must not churn the node's preferences.
 */
export function applyToolBridgePlan(
	target: ApiTarget,
	plan: ToolBridgePlan
): Promise<boolean> {
	if (plan.changes.length === 0) {
		return Promise.resolve(true);
	}
	const entries: Record<string, boolean> = {};
	for (const change of plan.changes) {
		entries[change.agentId] = change.to;
	}
	return setAgentToolBridgeMany(target, entries);
}
