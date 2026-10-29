// Shared agent + model selection for the builder chat panes (agent builder,
// workflow builder, …). Mirrors the chat composer's pickers so a builder
// conversation isn't fixed to the flagship `ryu` agent: the user can drive the
// build with any agent and pick its model. Returns the picker state plus a
// stable `bodyFields()` the builder transport spreads into the chat request, so
// the closure always reads the live agent/model.

import { useCallback, useMemo, useRef, useState } from "react";
import type { ModelOption } from "@/components/agent-elements/types.ts";
import {
	getAcpConfig,
	getAcpMode,
	getAcpModel,
} from "@/src/lib/acp-selections.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import {
	type ChatResponseMode,
	type ChatRoutingFields,
	modelRoutingFieldsForInterface,
	responseModeForInterface,
	type SimpleApprovalDefaults,
} from "@/src/lib/chat-routing.ts";
import { readInterfaceLevel } from "@/src/lib/interface-level.ts";
import {
	getAgentModel,
	modelsForAgent,
	setAgentModel,
} from "@/src/lib/models.ts";
import { useAgents } from "./useAgents.ts";
import { useEngineModels } from "./useEngineModels.ts";

/** The agent a builder pane defaults to — the flagship `ryu`, which reliably runs
 *  the in-process tool loop the `*_builder.*` tools need. */
export const DEFAULT_BUILDER_AGENT = "ryu";

/** Synthetic "no real model" id `modelsForAgent` returns when an agent advertises
 *  no model selection of its own; never sent as an override. */
const AUTO_MODEL = "auto";

/** Whether the agent runs on an ACP transport (its model rides `acp_model`); a
 *  local mirror of ChatPage's `isAcpAgent` so the hook stays self-contained. */
function isAcpAgent(agentId: string, agents: AgentSummary[]): boolean {
	if (agentId.startsWith("acp:")) {
		return true;
	}
	const agent = agents.find((a) => a.id === agentId);
	if (!agent) {
		// Unknown id — default to ACP (no gateway required) to avoid false blocks.
		return true;
	}
	if (agent.transport) {
		return agent.transport !== "openai_compat";
	}
	if (agent.builtIn) {
		return true;
	}
	return agent.engine?.startsWith("acp:") ?? false;
}

/** Body fields a builder turn merges into the chat request to target the chosen
 *  agent + model. `model` (catalog/openai-compat) vs `acp_model` (ACP) are routed
 *  by the agent's transport, matching the chat composer. */
export interface BuilderBodyFields extends ChatRoutingFields {
	agent_id: string;
	response_mode: ChatResponseMode;
}

export interface BuilderRuntime {
	agentId: string;
	/** Stable: reads the live agent/model via a ref, for the transport closure. */
	bodyFields: () => BuilderBodyFields;
	effectiveModel: string | null;
	modelOptions: ModelOption[];
	setAgentId: (id: string) => void;
	setModel: (id: string) => void;
	setSimpleApprovalDefaults: (defaults: SimpleApprovalDefaults | null) => void;
}

/**
 * Owns the builder pane's agent + model selection.
 *
 * @param storageKey localStorage key for the per-builder agent choice (so the
 *   agent builder and workflow builder remember independently). The model choice
 *   reuses the shared per-agent `getAgentModel`/`setAgentModel` table.
 */
export function useBuilderRuntime(storageKey: string): BuilderRuntime {
	const { agents } = useAgents();
	const engineModels = useEngineModels();

	const [agentId, setAgentIdState] = useState<string>(
		() => localStorage.getItem(storageKey) ?? DEFAULT_BUILDER_AGENT
	);
	const [selectedModel, setSelectedModel] = useState<string | null>(() =>
		getAgentModel(localStorage.getItem(storageKey) ?? DEFAULT_BUILDER_AGENT)
	);

	const modelOptions = useMemo(
		() => modelsForAgent(agentId, agents, engineModels),
		[agentId, agents, engineModels]
	);

	// Prefer the in-session pick, then the persisted per-agent choice, then the
	// engine's first option — so the picker shows what will actually be sent.
	const effectiveModel =
		[selectedModel, getAgentModel(agentId)].find(
			(id) => id && modelOptions.some((m) => m.id === id)
		) ??
		modelOptions[0]?.id ??
		null;

	const setAgentId = useCallback(
		(id: string) => {
			setAgentIdState(id);
			localStorage.setItem(storageKey, id);
			setSelectedModel(getAgentModel(id));
		},
		[storageKey]
	);

	const setModel = useCallback(
		(id: string) => {
			setSelectedModel(id);
			setAgentModel(agentId, id);
		},
		[agentId]
	);

	// Live snapshot the stable `bodyFields` closure reads at send time.
	const liveRef = useRef({ agentId, effectiveModel, isAcp: false });
	liveRef.current = {
		agentId,
		effectiveModel,
		isAcp: isAcpAgent(agentId, agents),
	};
	const simpleApprovalDefaultsRef = useRef<SimpleApprovalDefaults | null>(null);
	const setSimpleApprovalDefaults = useCallback(
		(defaults: SimpleApprovalDefaults | null) => {
			simpleApprovalDefaultsRef.current = defaults;
		},
		[]
	);

	const bodyFields = useCallback((): BuilderBodyFields => {
		const { agentId: id, effectiveModel: model, isAcp } = liveRef.current;
		const override = model && model !== AUTO_MODEL ? model : undefined;
		const interfaceLevel = readInterfaceLevel();
		const routingFields = modelRoutingFieldsForInterface(interfaceLevel, {
			model: isAcp ? null : override,
			acpModel: isAcp ? (getAcpModel(id) ?? override) : null,
			acpMode: isAcp ? getAcpMode(id) : null,
			acpConfig: isAcp ? getAcpConfig(id) : undefined,
			simpleApprovalDefaults: simpleApprovalDefaultsRef.current,
		});
		return {
			agent_id: id,
			response_mode: responseModeForInterface(interfaceLevel),
			...routingFields,
		};
	}, []);

	return {
		agentId,
		setAgentId,
		modelOptions,
		effectiveModel,
		setModel,
		bodyFields,
		setSimpleApprovalDefaults,
	};
}
