/*
 * This module validates untrusted Core/WebSocket JSON at the boundary before
 * returning domain types, so these guards must accept and inspect raw values.
 */
// oxlint-disable anti-slop/no-unknown-parameters
// oxlint-disable anti-slop/no-unsafe-dictionary-type
// oxlint-disable anti-slop/no-runtime-typeof

/** One provider/model choice recorded in shared conversation history. */
export type ConversationModelChangeKind = "change" | "initial";

export interface ConversationModelChange {
	changedBy: string | null;
	createdAt: number;
	id: string;
	kind: ConversationModelChangeKind;
	modelId: string | null;
	modelLabel: string | null;
	providerId: string | null;
	providerLabel: string | null;
	sequence: number;
}

/**
 * The transcript marker Core leaves when a model change handed the earlier
 * history off as a summary (`context.handoff-on-model-change`).
 */
export interface ConversationContextHandoff {
	createdAt: number;
	fromContext: number | null;
	fromModel: string | null;
	id: string;
	modelChangeId: string;
	reason: string;
	summarizedCount: number;
	summary: string | null;
	toContext: number | null;
	toModel: string | null;
}

export interface ConversationModelSelectionState {
	changes: ConversationModelChange[];
	current: ConversationModelChange | null;
	handoffs: ConversationContextHandoff[];
}

export interface RecordConversationModelSelectionInput {
	changeId: string;
	kind: ConversationModelChangeKind;
	modelId: string | null;
	modelLabel: string | null;
	providerId: string | null;
	providerLabel: string | null;
}

export interface RecordConversationModelSelectionResult {
	change: ConversationModelChange;
	changed: boolean;
}

export interface ConversationContextHandoffFrame {
	conversationId: string;
	handoff: ConversationContextHandoff;
}

export interface ConversationModelSelectionFrame {
	change: ConversationModelChange;
	conversationId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isNullableInteger(value: unknown): value is number | null {
	return (
		value === null ||
		(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
	);
}

/** Parse one applied handoff marker. Not-needed evaluations are never sent. */
export function parseConversationContextHandoff(
	value: unknown
): ConversationContextHandoff | null {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.modelChangeId !== "string" ||
		value.outcome !== "applied" ||
		typeof value.reason !== "string" ||
		typeof value.createdAt !== "number" ||
		!Number.isSafeInteger(value.createdAt) ||
		typeof value.summarizedCount !== "number" ||
		!Number.isSafeInteger(value.summarizedCount) ||
		!isNullableString(value.fromModel) ||
		!isNullableString(value.toModel) ||
		!isNullableString(value.summary) ||
		!isNullableInteger(value.fromContext) ||
		!isNullableInteger(value.toContext)
	) {
		return null;
	}
	return {
		createdAt: value.createdAt,
		fromContext: value.fromContext,
		fromModel: value.fromModel,
		id: value.id,
		modelChangeId: value.modelChangeId,
		reason: value.reason,
		summarizedCount: value.summarizedCount,
		summary: value.summary,
		toContext: value.toContext,
		toModel: value.toModel,
	};
}

/** Parse the room event Core sends when a turn records a handoff. */
export function parseConversationContextHandoffFrame(
	value: unknown
): ConversationContextHandoffFrame | null {
	if (
		!isRecord(value) ||
		value.type !== "contextHandoff" ||
		typeof value.conversationId !== "string"
	) {
		return null;
	}
	const handoff = parseConversationContextHandoff(value.handoff);
	return handoff ? { conversationId: value.conversationId, handoff } : null;
}

/** Parse a realtime payload at the WebSocket boundary. */
export function parseConversationModelChange(
	value: unknown
): ConversationModelChange | null {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		(value.kind !== "change" && value.kind !== "initial") ||
		typeof value.sequence !== "number" ||
		!Number.isSafeInteger(value.sequence) ||
		typeof value.createdAt !== "number" ||
		!Number.isSafeInteger(value.createdAt) ||
		!isNullableString(value.providerId) ||
		!isNullableString(value.providerLabel) ||
		!isNullableString(value.modelId) ||
		!isNullableString(value.modelLabel) ||
		!isNullableString(value.changedBy)
	) {
		return null;
	}
	return {
		changedBy: value.changedBy,
		createdAt: value.createdAt,
		id: value.id,
		kind: value.kind,
		modelId: value.modelId,
		modelLabel: value.modelLabel,
		providerId: value.providerId,
		providerLabel: value.providerLabel,
		sequence: value.sequence,
	};
}

/** Parse the shared room event before applying it to the active transcript. */
export function parseConversationModelSelectionFrame(
	value: unknown
): ConversationModelSelectionFrame | null {
	if (
		!isRecord(value) ||
		value.type !== "modelSelection" ||
		typeof value.conversationId !== "string"
	) {
		return null;
	}
	const change = parseConversationModelChange(value.change);
	return change ? { change, conversationId: value.conversationId } : null;
}

export function parseConversationModelSelectionState(
	value: unknown
): ConversationModelSelectionState {
	if (!(isRecord(value) && Array.isArray(value.changes))) {
		throw new Error("Core returned an invalid conversation model history");
	}
	const changes = value.changes.map(parseConversationModelChange);
	if (changes.some((change) => change === null)) {
		throw new Error("Core returned an invalid conversation model change");
	}
	const parsedChanges = changes.filter(
		(change): change is ConversationModelChange => change !== null
	);
	const current =
		value.current === null ? null : parseConversationModelChange(value.current);
	if (value.current !== null && current === null) {
		throw new Error("Core returned an invalid current model selection");
	}
	// Older nodes predate handoffs; a malformed marker is dropped rather than
	// failing the whole history, since it is display-only.
	const handoffs = Array.isArray(value.handoffs)
		? value.handoffs
				.map(parseConversationContextHandoff)
				.filter(
					(handoff): handoff is ConversationContextHandoff => handoff !== null
				)
		: [];
	return { changes: parsedChanges, current, handoffs };
}

export function parseConversationModelSelectionWriteResult(
	value: unknown
): RecordConversationModelSelectionResult {
	if (!isRecord(value) || typeof value.changed !== "boolean") {
		throw new Error("Core returned an invalid model-selection response");
	}
	const change = parseConversationModelChange(value.change);
	if (!change) {
		throw new Error("Core returned an invalid model-selection event");
	}
	return { change, changed: value.changed };
}
