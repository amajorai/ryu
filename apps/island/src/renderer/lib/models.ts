import type { ModelOption } from "@ryu/blocks/composer/types";
import type { CoreAgentSummary } from "../../shared/ipc.ts";

const ENGINE_MODELS_FALLBACK: Record<string, ModelOption[]> = {
	claude: [
		{ id: "opus", name: "Opus" },
		{ id: "sonnet", name: "Sonnet" },
		{ id: "fable", name: "Fable" },
		{ id: "haiku", name: "Haiku" },
	],
	codex: [
		{ id: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max" },
		{ id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
		{ id: "gpt-5.1", name: "GPT-5.1" },
	],
	gemini: [
		{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
		{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
	],
	pi: [{ id: "default", name: "Default" }],
	hermes: [{ id: "hermes3", name: "Hermes 3" }],
	local: [{ id: "gemma-4-e2b-it", name: "Gemma 4 E2B" }],
	ryu: [{ id: "gemma-4-e2b-it", name: "Gemma 4 E2B" }],
};

function resolveEngine(
	agentId: string | null,
	agents: CoreAgentSummary[]
): string | null {
	if (!agentId) {
		return null;
	}
	if (agentId.startsWith("acp:")) {
		return agentId.slice("acp:".length);
	}
	const agent = agents.find((a) => a.id === agentId);
	if (!agent) {
		return agentId;
	}
	const engine = agent.engine ?? (agent.builtIn ? agent.id : null);
	if (!engine) {
		return null;
	}
	return engine.startsWith("acp:") ? engine.slice("acp:".length) : engine;
}

export function modelsForAgent(
	agentId: string | null,
	agents: CoreAgentSummary[],
	catalog?: Record<string, ModelOption[]>
): ModelOption[] {
	const engine = resolveEngine(agentId, agents);
	if (engine) {
		const fromCore = catalog?.[engine];
		if (fromCore && fromCore.length > 0) {
			return fromCore;
		}
		if (ENGINE_MODELS_FALLBACK[engine]) {
			return ENGINE_MODELS_FALLBACK[engine];
		}
	}
	const agent = agentId ? agents.find((a) => a.id === agentId) : undefined;
	if (agent?.model) {
		return [{ id: agent.model, name: agent.model }];
	}
	return [{ id: "auto", name: "Auto" }];
}

const SELECTION_KEY = "ryu_agent_model_selection";

function readSelections(): Record<string, string> {
	try {
		const raw = localStorage.getItem(SELECTION_KEY);
		return raw ? (JSON.parse(raw) as Record<string, string>) : {};
	} catch {
		return {};
	}
}

export function getAgentModel(agentId: string | null): string | null {
	if (!agentId) {
		return null;
	}
	return readSelections()[agentId] ?? null;
}

export function setAgentModel(agentId: string, modelId: string): void {
	const selections = readSelections();
	selections[agentId] = modelId;
	localStorage.setItem(SELECTION_KEY, JSON.stringify(selections));
}
