/**
 * Small client-side queue for prompts entered while a chat stream is active.
 * Core remains single-flight per conversation; the next prompt is submitted
 * only after the current stream has settled.
 */

import { z } from "zod";
import type { ChatStreamOptions } from "./chatStream.ts";

export const MAX_QUEUED_CHAT_MESSAGES = 50;
const queuedStreamOptionsSchema = z
	.object({
		acpConfig: z.record(z.string(), z.string()).optional(),
		acpMode: z.string().optional(),
		acpModel: z.string().optional(),
		agentId: z.string().optional(),
		conversationId: z.string().optional(),
		enableLongTerm: z.boolean().optional(),
		pluginFlags: z.record(z.string(), z.boolean()).optional(),
		teamId: z.string().optional(),
		workflowId: z.string().optional(),
	})
	.optional();
const queuedTurnInputSchema = z.object({
	text: z.string(),
	createdAt: z.number().optional(),
	id: z.string().optional(),
	options: queuedStreamOptionsSchema,
});
const queuedTextSchema = z.string();
const queuedMessageTextSchema = z.union([
	queuedTextSchema,
	z.object({ text: queuedTextSchema }).transform((input) => input.text),
]);

/** The immutable per-turn data needed to submit a queued prompt later. */
export interface QueuedChatTurn {
	createdAt: number;
	id: string;
	options: ChatStreamOptions;
	text: string;
}

/** Input accepted by the typed queue helpers. */
export interface QueuedChatTurnInput {
	createdAt?: number;
	id?: string;
	options?: ChatStreamOptions;
	text: string;
}

/** Injectable clock and id factory for deterministic queue tests. */
export interface QueuedChatTurnFactoryOptions {
	idFactory?: (createdAt: number, sequence: number) => string;
	now?: () => number;
}

export interface EnqueueChatTurnResult {
	accepted: boolean;
	queue: QueuedChatTurn[];
}

export interface DequeueChatTurnResult {
	queue: QueuedChatTurn[];
	turn: QueuedChatTurn | null;
}

/** The queue is an array so each transition can be a pure value operation. */
export type ChatQueueState = readonly QueuedChatTurn[];

export type ChatQueueAction =
	| {
			type: "enqueue";
			input: QueuedChatTurnInput;
			factoryOptions?: QueuedChatTurnFactoryOptions;
	  }
	| {
			type: "enqueue";
			createdAt?: number;
			factoryOptions?: QueuedChatTurnFactoryOptions;
			id?: string;
			options?: ChatStreamOptions;
			text: string;
	  }
	| { type: "enqueue"; turn: QueuedChatTurn }
	| { type: "dequeue" }
	| { id: string; type: "remove" }
	| { id: string; type: "remove-by-id" }
	| { type: "clear" };

let queuedTurnSequence = 0;

function defaultQueuedTurnId(createdAt: number, sequence: number): string {
	return `chat-turn-${createdAt}-${sequence}`;
}

function snapshotChatStreamOptions(
	options: ChatStreamOptions | undefined
): ChatStreamOptions {
	if (!options) {
		return {};
	}

	const snapshot = { ...options };
	if (options.acpConfig) {
		snapshot.acpConfig = { ...options.acpConfig };
	}
	if (options.pluginFlags) {
		snapshot.pluginFlags = { ...options.pluginFlags };
	}
	return snapshot;
}

function cloneQueuedChatTurn(turn: QueuedChatTurn): QueuedChatTurn {
	return {
		...turn,
		options: snapshotChatStreamOptions(turn.options),
	};
}

function inputParts(
	input: string | QueuedChatTurnInput,
	options?: ChatStreamOptions
): QueuedChatTurnInput {
	const text = queuedTextSchema.safeParse(input);
	return text.success
		? { text: text.data, options }
		: queuedTurnInputSchema.parse(input);
}
function factoryParts(
	value: ChatStreamOptions | QueuedChatTurnFactoryOptions | undefined
): QueuedChatTurnFactoryOptions | undefined {
	if (!value) {
		return undefined;
	}
	return {
		now: "now" in value ? value.now : undefined,
		idFactory: "idFactory" in value ? value.idFactory : undefined,
	};
}

/**
 * Creates one normalized turn. `id` and `createdAt` are assigned once here;
 * queue transitions only move or remove the resulting value.
 */
export function createQueuedChatTurn(
	input: string,
	options?: ChatStreamOptions,
	factoryOptions?: QueuedChatTurnFactoryOptions
): QueuedChatTurn;
export function createQueuedChatTurn(
	input: QueuedChatTurnInput,
	factoryOptions?: QueuedChatTurnFactoryOptions
): QueuedChatTurn;
export function createQueuedChatTurn(
	input: string | QueuedChatTurnInput,
	optionsOrFactory?: ChatStreamOptions | QueuedChatTurnFactoryOptions,
	factoryOptionsArg?: QueuedChatTurnFactoryOptions
): QueuedChatTurn {
	return createQueuedTurnFromArguments(
		input,
		optionsOrFactory,
		factoryOptionsArg
	);
}

function createQueuedTurnFromArguments(
	input: string | QueuedChatTurnInput,
	optionsOrFactory?: ChatStreamOptions | QueuedChatTurnFactoryOptions,
	factoryOptionsArg?: QueuedChatTurnFactoryOptions
): QueuedChatTurn {
	const isStringInput = queuedTextSchema.safeParse(input).success;
	const factoryArgument =
		optionsOrFactory &&
		("now" in optionsOrFactory || "idFactory" in optionsOrFactory);
	const options =
		isStringInput && !factoryArgument
			? queuedStreamOptionsSchema.parse(optionsOrFactory)
			: undefined;
	const factoryOptions = isStringInput
		? (factoryOptionsArg ??
			(factoryArgument ? factoryParts(optionsOrFactory) : undefined))
		: factoryParts(optionsOrFactory);
	const parts = inputParts(input, options);
	const text = parts.text.trim();
	const createdAt = parts.createdAt ?? (factoryOptions?.now ?? Date.now)();
	queuedTurnSequence += 1;
	const id =
		parts.id ??
		(factoryOptions?.idFactory ?? defaultQueuedTurnId)(
			createdAt,
			queuedTurnSequence
		);

	return {
		createdAt,
		id,
		options: snapshotChatStreamOptions(parts.options),
		text,
	};
}

export function enqueueChatTurn(
	queue: readonly QueuedChatTurn[],
	input: string,
	options?: ChatStreamOptions,
	factoryOptions?: QueuedChatTurnFactoryOptions
): EnqueueChatTurnResult;
export function enqueueChatTurn(
	queue: readonly QueuedChatTurn[],
	input: QueuedChatTurnInput,
	factoryOptions?: QueuedChatTurnFactoryOptions
): EnqueueChatTurnResult;
export function enqueueChatTurn(
	queue: readonly QueuedChatTurn[],
	input: string | QueuedChatTurnInput,
	optionsOrFactory?: ChatStreamOptions | QueuedChatTurnFactoryOptions,
	factoryOptions?: QueuedChatTurnFactoryOptions
): EnqueueChatTurnResult {
	const inputText = queuedMessageTextSchema.parse(input);
	if (
		inputText.trim().length === 0 ||
		queue.length >= MAX_QUEUED_CHAT_MESSAGES
	) {
		return { accepted: false, queue: [...queue] };
	}

	const turn = createQueuedTurnFromArguments(
		input,
		optionsOrFactory,
		factoryOptions
	);
	return { accepted: true, queue: [...queue, turn] };
}

export function dequeueChatTurn(
	queue: readonly QueuedChatTurn[]
): DequeueChatTurnResult {
	if (queue.length === 0) {
		return { queue: [], turn: null };
	}
	return { queue: queue.slice(1), turn: queue[0] ?? null };
}

export function removeQueuedChatTurn(
	queue: readonly QueuedChatTurn[],
	id: string
): QueuedChatTurn[] {
	return queue.filter((turn) => turn.id !== id);
}

export const removeChatTurn = removeQueuedChatTurn;

/** Move one queued turn without changing its id, timestamp, or routing snapshot. */
export function moveQueuedChatTurn(
	queue: readonly QueuedChatTurn[],
	id: string,
	direction: "up" | "down"
): QueuedChatTurn[] {
	const index = queue.findIndex((turn) => turn.id === id);
	if (index < 0) {
		return [...queue];
	}
	const nextIndex = direction === "up" ? index - 1 : index + 1;
	if (nextIndex < 0 || nextIndex >= queue.length) {
		return [...queue];
	}
	const next = [...queue];
	const current = next[index];
	const adjacent = next[nextIndex];
	if (!(current && adjacent)) {
		return next;
	}
	next[index] = adjacent;
	next[nextIndex] = current;
	return next;
}

export function clearChatQueue(
	_queue: readonly QueuedChatTurn[] = []
): QueuedChatTurn[] {
	return [];
}

/** Apply one pure queue action; useful for UI state and reducer-level tests. */
export function chatQueueReducer(
	state: ChatQueueState,
	action: ChatQueueAction
): QueuedChatTurn[] {
	switch (action.type) {
		case "enqueue": {
			if ("turn" in action) {
				if (
					state.length >= MAX_QUEUED_CHAT_MESSAGES ||
					action.turn.text.trim().length === 0
				) {
					return [...state];
				}
				return [...state, cloneQueuedChatTurn(action.turn)];
			}

			const result =
				"input" in action
					? enqueueChatTurn(state, action.input, action.factoryOptions)
					: enqueueChatTurn(
							state,
							{
								createdAt: action.createdAt,
								id: action.id,
								options: action.options,
								text: action.text,
							},
							action.factoryOptions
						);
			return result.queue;
		}
		case "dequeue":
			return dequeueChatTurn(state).queue;
		case "remove":
		case "remove-by-id":
			return removeQueuedChatTurn(state, action.id);
		case "clear":
			return clearChatQueue(state);
	}
}

export const transitionChatQueue = chatQueueReducer;

export interface EnqueueResult {
	accepted: boolean;
	queue: string[];
}

export function enqueueChatMessage(
	queue: readonly string[],
	input: string
): EnqueueResult {
	const message = input.trim();
	if (message.length === 0 || queue.length >= MAX_QUEUED_CHAT_MESSAGES) {
		return { accepted: false, queue: [...queue] };
	}
	return { accepted: true, queue: [...queue, message] };
}

export interface DequeueResult {
	message: string | null;
	queue: string[];
}

export function dequeueChatMessage(queue: readonly string[]): DequeueResult {
	if (queue.length === 0) {
		return { message: null, queue: [] };
	}
	return { message: queue[0] ?? null, queue: queue.slice(1) };
}
