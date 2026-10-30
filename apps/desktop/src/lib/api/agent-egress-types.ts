// apps/desktop/src/lib/api/agent-egress-types.ts
//
// Split out of `agent-egress.ts`; import from there. See that module's header.

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
	/**
	 * Whether the agent's model providers are limited: an account-access list,
	 * or only its own identity (Core's `user_provider_access`). A custom agent
	 * on the "Ryu" engine (`acp:pi`) then runs on Ryu's managed Pi under its
	 * own identity ({@link runsLimitedOnManagedPi}). Missing means unrestricted.
	 */
	modelsLimited?: boolean;
	name: string;
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
