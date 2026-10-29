import { nativeSdkSchemaAdmits } from "@ryu/blocks/desktop/agent-elements/utils/native-sdk-admission.ts";
import {
	type NativeSdkMessageFields,
	type NativeSdkValue,
	nativeReadbackContentSchema,
	nativeReadbackTextSchema,
} from "@ryu/blocks/desktop/agent-elements/utils/native-sdk-observation.ts";
import type { AgentSummary } from "./api/agents.ts";

/** Returns true when the selected agent uses ACP transport (never touches the gateway). */
export function isAcpAgent(
	agentId: string | null,
	agents: readonly Pick<
		AgentSummary,
		"id" | "transport" | "builtIn" | "engine"
	>[]
): boolean {
	if (!agentId) {
		// No agent selected — default to ACP behaviour (no gateway needed).
		return true;
	}
	// Engine ids selected directly from the engines list (e.g. "acp:claude")
	if (agentId.startsWith("acp:")) {
		return true;
	}
	// Check against known agents in the registry
	const agent = agents.find((a) => a.id === agentId);
	if (!agent) {
		// Unknown id — default to ACP (no gateway required) to avoid false blocks.
		return true;
	}
	// Prefer the transport Core reports — the authoritative signal — over any
	// client-side re-derivation. Only "openai_compat" needs the gateway.
	if (agent.transport) {
		return agent.transport !== "openai_compat";
	}
	// Registry built-ins are always ACP
	if (agent.builtIn) {
		return true;
	}
	// Custom agents: if engine is explicitly set to an ACP variant, it's ACP
	if (agent.engine?.startsWith("acp:")) {
		return true;
	}
	// Custom agents with an explicit non-ACP engine or no engine: default to ACP
	// (openai-compat agents would have a non-null engine that does NOT start with "acp:")
	if (agent.engine && !agent.engine.startsWith("acp:")) {
		return false;
	}
	return true;
}

/**
 * Build the version-pager map (message id → { index, count, ids }) from a loaded
 * history. Only messages that actually have alternate versions (siblingCount > 1
 * with sibling ids) get an entry, so the pager renders solely at real branch
 * points.
 */
export interface ChatVersionPager {
	count: number;
	ids: string[];
	index: number;
}
export interface ChatVersionPagers {
	[messageId: string]: ChatVersionPager;
}
export function buildVersions(
	history: Array<{
		id: string;
		siblingIndex?: number;
		siblingCount?: number;
		siblingIds?: string[];
	}>
): ChatVersionPagers {
	const map: ChatVersionPagers = {};
	for (const h of history) {
		if (h.siblingCount && h.siblingCount > 1 && h.siblingIds?.length) {
			map[h.id] = {
				index: h.siblingIndex ?? 0,
				count: h.siblingCount,
				ids: h.siblingIds,
			};
		}
	}
	return map;
}

/** Native SDK messages and legacy content retain their complete opaque values. */
export interface AssistantReadbackInput {
	content?: NativeSdkValue;
	parts?: NativeSdkValue[];
}
function hasNativeReadbackContent(
	message: AssistantReadbackInput
): message is AssistantReadbackInput & { content: string } {
	return nativeSdkSchemaAdmits(nativeReadbackContentSchema, message);
}

/** Plain text from the last assistant message's parts (for auto read-back). */
export function extractAssistantText(message: AssistantReadbackInput): string {
	if (Array.isArray(message.parts) && message.parts.length > 0) {
		return message.parts
			.filter(
				(
					part
				): part is NativeSdkMessageFields & { type: "text"; text: string } =>
					nativeSdkSchemaAdmits(nativeReadbackTextSchema, part)
			)
			.map((part) => part.text ?? "")
			.join("\n\n")
			.trim();
	}
	return hasNativeReadbackContent(message) ? message.content.trim() : "";
}
