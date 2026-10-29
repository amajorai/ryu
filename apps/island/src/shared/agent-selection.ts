import { z } from "zod";

// Shared AgentSelection shape for Island + desktop dictation prefs.
// Mirrors `apps/desktop/src/lib/api/preferences.ts` AgentSelection so the
// dictation preference blob can carry the same picker value the rest of the
// product uses (agent OR model + effort / thinking / access mode).

/** Full composer-style target: agent XOR model (+ optional effort/thinking/access). */
export interface AgentSelection {
	access_mode: string;
	agent_id: string;
	effort: string;
	model: string;
	provider: string;
	thinking_level: string;
}

/** All-unset selection — inherit the node default / fast local model. */
export const EMPTY_AGENT_SELECTION: AgentSelection = {
	access_mode: "",
	agent_id: "",
	effort: "",
	model: "",
	provider: "",
	thinking_level: "",
};

/** True when nothing is chosen. */
export function isAgentSelectionEmpty(selection: AgentSelection): boolean {
	return !(
		selection.agent_id ||
		selection.provider ||
		selection.model ||
		selection.thinking_level ||
		selection.effort ||
		selection.access_mode
	);
}

const selectionTextSchema = z.string().trim().catch("");
const selectionSchema = z
	.object({
		agent_id: selectionTextSchema,
		provider: selectionTextSchema,
		model: selectionTextSchema,
		thinking_level: selectionTextSchema,
		effort: selectionTextSchema,
		access_mode: selectionTextSchema,
	})
	.catch(EMPTY_AGENT_SELECTION);

type SelectionInput = Parameters<typeof selectionSchema.parse>[0];

/** Decode stored object selections and legacy plain or serialized model IDs. */
export function parseAgentSelection(value: SelectionInput): AgentSelection {
	const text = z.string().safeParse(value);
	if (text.success) {
		const trimmed = text.data.trim();
		if (!trimmed) {
			return EMPTY_AGENT_SELECTION;
		}
		if (!trimmed.startsWith("{")) {
			return { ...EMPTY_AGENT_SELECTION, model: trimmed };
		}
		try {
			return selectionSchema.parse(JSON.parse(trimmed));
		} catch {
			return EMPTY_AGENT_SELECTION;
		}
	}
	return selectionSchema.parse(value);
}

/** Prefer an explicit selection; preserve the older agent-ID preference. */
export function parseAgentSelectionWithLegacyAgent(
	selection: SelectionInput,
	legacyAgent: SelectionInput
): AgentSelection {
	const fromSelection = parseAgentSelection(selection);
	if (!isAgentSelectionEmpty(fromSelection)) {
		return fromSelection;
	}
	const agent = selectionTextSchema.parse(legacyAgent);
	return agent
		? { ...EMPTY_AGENT_SELECTION, agent_id: agent }
		: EMPTY_AGENT_SELECTION;
}
