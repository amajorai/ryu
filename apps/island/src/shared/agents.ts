// Island agent-routing preference: the cross-process contract persisted in Core
// under the `island-agents` key. The desktop writes it from its Island settings;
// the island companion (a separate Electron process that cannot share the
// desktop's localStorage) reads it on startup, subscribes to live changes, and
// uses it to pick (1) the agent its conversational chat routes to and (2) the
// agent the proactive suggestion engine uses. Mirrors `shared/voice.ts`: a plain
// schema with no `@ryu/ui` dependency, because the main process externalizes
// workspace deps and cannot import `@ryu/ui`.
//
// Both surfaces default to the flagship `ryu` agent (Pi + Gateway), the only
// agent installed out of the box. Like every Ryu default, it is swappable, never
// a lock; an empty string means "Core's default local model" (no agent).

/** Preference key shared with the desktop's preferences client + Core KV store. */
export const ISLAND_AGENTS_PREF_KEY = "island-agents";

/** The default agent id every surface falls back to (the locked flagship). */
export const DEFAULT_AGENT_ID = "ryu";

/**
 * The agent-routing blob persisted under {@link ISLAND_AGENTS_PREF_KEY}. An empty
 * string for either field means "Core's default local model" (the fast Gemma
 * completion, no agent subprocess).
 */
export interface IslandAgentPrefs {
	/** Agent for the proactive suggestion engine. */
	proactiveAgent: string;
	/** Agent for the island's conversational chat (voice + typed input). */
	voiceAgent: string;
}

/** Default: both surfaces use the flagship `ryu` agent. */
export const DEFAULT_ISLAND_AGENT_PREFS: IslandAgentPrefs = {
	voiceAgent: DEFAULT_AGENT_ID,
	proactiveAgent: DEFAULT_AGENT_ID,
};

/**
 * Tolerantly coerce a raw preference value (JSON string from Core, or `null`)
 * into {@link IslandAgentPrefs}. Falls back to the default for any missing/unknown
 * field so a malformed blob never breaks chat or the suggestion engine.
 */
export function parseIslandAgentPrefs(raw: string | null): IslandAgentPrefs {
	if (!raw) {
		return DEFAULT_ISLAND_AGENT_PREFS;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<IslandAgentPrefs>;
		return {
			voiceAgent:
				typeof parsed.voiceAgent === "string"
					? parsed.voiceAgent
					: DEFAULT_AGENT_ID,
			proactiveAgent:
				typeof parsed.proactiveAgent === "string"
					? parsed.proactiveAgent
					: DEFAULT_AGENT_ID,
		};
	} catch {
		return DEFAULT_ISLAND_AGENT_PREFS;
	}
}

/** Normalize an agent id to the chat request's `agent_id` (empty = undefined). */
export function agentIdOrUndefined(agent: string): string | undefined {
	return agent.length > 0 ? agent : undefined;
}
