// apps/desktop/src/lib/acp-selections.ts
//
// Per-agent persistence of the user's ACP session-control choices — permission
// mode, reasoning-effort / config-option values, and model. Mirrors the
// per-agent model selection in `models.ts`: the choice is sticky across
// restarts and re-sent on every turn (Core re-applies it to that turn's session,
// since ACP sessions are per-turn). The agent itself owns nothing here; these
// are local "last used" hints keyed by agent id.

import { isNativeObjectLike } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";

const selectionEntriesSchema = z.array(z.tuple([z.string(), z.string()]));

function parseSelections<StoredInput>(value: StoredInput) {
	if (!isNativeObjectLike(value) || Array.isArray(value)) {
		throw new Error("Invalid stored ACP selection map");
	}
	return Object.fromEntries(
		selectionEntriesSchema.parse(Object.entries(new Object(value)))
	);
}

type AcpSelections = ReturnType<typeof parseSelections>;

function parseConfigSelections<StoredInput>(value: StoredInput) {
	if (!isNativeObjectLike(value) || Array.isArray(value)) {
		throw new Error("Invalid stored ACP config map");
	}
	return Object.fromEntries(
		Object.entries(new Object(value)).map(
			([agentId, selections]) => [agentId, parseSelections(selections)] as const
		)
	);
}

const MODE_KEY = "ryu_acp_mode";
const CONFIG_KEY = "ryu_acp_config";
const MODEL_KEY = "ryu_acp_model";

function readMap(key: string): AcpSelections {
	try {
		const raw = localStorage.getItem(key);
		return raw ? parseSelections(JSON.parse(raw)) : {};
	} catch {
		return {};
	}
}

function writeMap(key: string, map: AcpSelections): void {
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
	const selections = readMap(MODE_KEY);
	return Object.hasOwn(selections, agentId) ? selections[agentId] : null;
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
	const selections = readMap(MODEL_KEY);
	return Object.hasOwn(selections, agentId) ? selections[agentId] : null;
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
export function getAcpConfig(agentId: string | null): AcpSelections {
	if (!agentId) {
		return {};
	}
	try {
		const raw = localStorage.getItem(CONFIG_KEY);
		const all = raw ? parseConfigSelections(JSON.parse(raw)) : {};
		return Object.hasOwn(all, agentId) ? all[agentId] : {};
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
		const all = raw ? parseConfigSelections(JSON.parse(raw)) : {};
		all[agentId] = { ...all[agentId], [configId]: valueId };
		localStorage.setItem(CONFIG_KEY, JSON.stringify(all));
	} catch {
		// Storage unavailable — selection won't persist.
	}
}
