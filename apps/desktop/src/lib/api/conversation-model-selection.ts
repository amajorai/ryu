import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
import type { ApiTarget } from "./client.ts";
import { request } from "./client.ts";
import {
	type ConversationModelSelectionState,
	parseConversationModelSelectionState,
	parseConversationModelSelectionWriteResult,
	type RecordConversationModelSelectionInput,
	type RecordConversationModelSelectionResult,
} from "./conversation-model-selection-schema.ts";

export type {
	ConversationContextHandoff,
	ConversationContextHandoffFrame,
	ConversationModelChange,
	ConversationModelChangeKind,
	ConversationModelSelectionFrame,
	ConversationModelSelectionState,
	RecordConversationModelSelectionInput,
	RecordConversationModelSelectionResult,
} from "./conversation-model-selection-schema.ts";
export {
	parseConversationContextHandoff,
	parseConversationContextHandoffFrame,
	parseConversationModelChange,
	parseConversationModelSelectionFrame,
	parseConversationModelSelectionState,
	parseConversationModelSelectionWriteResult,
} from "./conversation-model-selection-schema.ts";

function conversationModelSelectionPath(conversationId: string): string {
	return `/api/conversations/${encodeURIComponent(conversationId)}/model-selection`;
}

/** Load the shared selection and its full change history for one conversation. */
export async function getConversationModelSelection(
	target: ApiTarget,
	conversationId: string
): Promise<ConversationModelSelectionState> {
	const response = await request(
		target,
		conversationModelSelectionPath(conversationId),
		undefined,
		gatewayJsonValueSchema
	);
	return parseConversationModelSelectionState(response);
}

/** Persist a conversation-level provider/model choice and return its event. */
export async function recordConversationModelSelection(
	target: ApiTarget,
	conversationId: string,
	input: RecordConversationModelSelectionInput
): Promise<RecordConversationModelSelectionResult> {
	const response = await request(
		target,
		conversationModelSelectionPath(conversationId),
		{ method: "PUT", body: input },
		gatewayJsonValueSchema
	);
	return parseConversationModelSelectionWriteResult(response);
}
