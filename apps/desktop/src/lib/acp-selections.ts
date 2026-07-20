// apps/desktop/src/lib/acp-selections.ts
//
// Per-agent persistence of the user's ACP session-control choices — permission
// mode, reasoning-effort / config-option values, and model. Mirrors the
// per-agent model selection in `models.ts`: the choice is sticky across
// restarts and re-sent on every turn (Core re-applies it to that turn's session,
// since ACP sessions are per-turn). The agent itself owns nothing here; these
// are local "last used" hints keyed by agent id.

const MODE_KEY = "ryu_acp_mode";
const CONFIG_KEY = "ryu_acp_config";
const MODEL_KEY = "ryu_acp_model";

function readMap(key: string): Record<string, string> {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as Record<string, string>) : {};
	} catch {
		return {};
	}
}

function writeMap(key: string, map: Record<string, string>): void {
	try {
		localStorage.setItem(key, JSON.stringify(map));
	} catch {
		// Storage unavailable — selection simply won't persist this session.
	}
}

/** The permission mode last picked for this agent, or null. */
export function getAcpMode(agentId: string | null): string | null {
	if (!agentId) {
		return null;
	}
	return readMap(MODE_KEY)[agentId] ?? null;
}

export function setAcpMode(agentId: string, modeId: string): void {
	const map = readMap(MODE_KEY);
	map[agentId] = modeId;
	writeMap(MODE_KEY, map);
}

/** The model last picked for this agent over ACP, or null. */
export function getAcpModel(agentId: string | null): string | null {
	if (!agentId) {
		return null;
	}
	return readMap(MODEL_KEY)[agentId] ?? null;
}

export function setAcpModel(agentId: string, modelId: string): void {
	const map = readMap(MODEL_KEY);
	map[agentId] = modelId;
	writeMap(MODEL_KEY, map);
}

/**
 * Config-option selections for an agent as `{ configId: valueId }` (e.g. a
 * reasoning-effort selector). Stored as a nested map keyed by agent id.
 */
export function getAcpConfig(agentId: string | null): Record<string, string> {
	if (!agentId) {
		return {};
	}
	try {
		const raw = localStorage.getItem(CONFIG_KEY);
		const all = raw
			? (JSON.parse(raw) as Record<string, Record<string, string>>)
			: {};
		return all[agentId] ?? {};
	} catch {
		return {};
	}
}

export function setAcpConfigValue(
	agentId: string,
	configId: string,
	valueId: string
): void {
	try {
		const raw = localStorage.getItem(CONFIG_KEY);
		const all = raw
			? (JSON.parse(raw) as Record<string, Record<string, string>>)
			: {};
		all[agentId] = { ...(all[agentId] ?? {}), [configId]: valueId };
		localStorage.setItem(CONFIG_KEY, JSON.stringify(all));
	} catch {
		// Storage unavailable — selection won't persist.
	}
}
