import { z } from "zod";
import type {
	ManagedAgent,
	ManagedAgentCredential,
	ManagedAgentEnvironment,
	ManagedAgentEvent,
	ManagedAgentEventEnvelope,
	ManagedAgentEventList,
	ManagedAgentJsonObject,
	ManagedAgentJsonValue,
	ManagedAgentSession,
	ManagedAgentStreamEnd,
	ManagedAgentsList,
	ManagedAgentVersion,
} from "./managed-agents.ts";

// packages/client/src/managed-agents-contracts.ts
//
// Response contracts for the Ryu Managed Agents API. They mirror the tolerant response parsers in
// `@ryuhq/protocol/managed-agents` without depending on that package: each contract validates the
// declared fields and returns the raw value, so fields added later in v1 are kept. Parity with the
// protocol is proven by parsing the shared protocol fixtures in `managed-agents.test.ts`.

/** Every session status declared in v1. */
export const MANAGED_AGENT_SESSION_STATUSES = [
	"pending",
	"running",
	"idle",
	"completed",
	"failed",
	"canceled",
] as const;

/** Every event type declared in v1. `agent.message.delta` is reserved and never emitted in v1. */
export const MANAGED_AGENT_EVENT_TYPES = [
	"user.message",
	"user.interrupt",
	"user.custom_tool_result",
	"user.tool_approval",
	"agent.message",
	"agent.message.delta",
	"agent.tool_use",
	"agent.tool_result",
	"agent.custom_tool_use",
	"agent.tool_approval_request",
	"session.status",
	"session.error",
	"session.usage",
] as const;

const knownEventTypes: ReadonlySet<string> = new Set(MANAGED_AGENT_EVENT_TYPES);
const terminalStatuses: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"canceled",
]);

/** Whether an event type is declared in this contract version. */
export function isKnownManagedAgentEventType(type: string): boolean {
	return knownEventTypes.has(type);
}

/** Whether a session status is terminal (`completed`, `failed` or `canceled`). */
export function isTerminalManagedAgentSessionStatus(status: string): boolean {
	return terminalStatuses.has(status);
}

const wireText = z.string();
const wireNullableText = wireText.nullable();
const wireCount = z.int().min(0);
const wireRecord = z.record(z.string(), z.unknown());
/** A JSON object; values JSON cannot carry (undefined, NaN, Infinity, functions) fail. */
const wireJsonObject = z.record(z.string(), z.json());

function isUnknownTag(known: readonly string[]) {
	return wireText.refine((value) => !known.includes(value));
}

const toolValidation = z.union([
	z.object({
		type: z.literal("builtin"),
		name: wireText,
		allowedDomains: z.array(wireText),
		requireApproval: z.boolean().optional(),
	}),
	z.object({
		type: z.literal("custom"),
		name: wireText,
		description: wireText,
		inputSchema: wireJsonObject,
	}),
	z.object({ type: isUnknownTag(["builtin", "custom"]) }),
]);

const mcpServerValidation = z.object({
	name: wireText,
	url: wireText,
	allowedTools: z.array(wireText).nullable(),
	requireApproval: z.boolean().optional(),
});

const agentConfigFields = {
	name: wireText,
	description: wireNullableText,
	model: wireNullableText,
	instructions: wireNullableText,
	tools: z.array(toolValidation),
	mcpServers: z.array(mcpServerValidation),
	reasoningEffort: wireNullableText,
	metadata: z.record(z.string(), z.string()),
	createdAt: wireText,
};

const agentValidation = z.object({
	...agentConfigFields,
	id: wireText,
	version: z.int().min(1),
	archivedAt: wireNullableText,
	updatedAt: wireText,
});

const agentVersionValidation = z.object({
	...agentConfigFields,
	agentId: wireText,
	version: z.int().min(1),
});

const credentialRefValidation = z.union([
	z.object({ source: z.literal("byok"), credentialId: wireText }),
	z.object({ source: isUnknownTag(["byok"]) }),
]);

const environmentValidation = z.object({
	id: wireText,
	name: wireText,
	description: wireNullableText,
	backend: wireText,
	credential: credentialRefValidation,
	config: wireRecord,
	revision: z.int().min(1),
	archivedAt: wireNullableText,
	createdAt: wireText,
	updatedAt: wireText,
});

const credentialValidation = z.object({
	id: wireText,
	provider: wireText,
	label: wireText,
	keyHint: wireText,
	fingerprint: wireText,
	createdAt: wireText,
	updatedAt: wireText,
	revokedAt: wireNullableText,
});

const usageValidation = z.object({
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheReadInputTokens: z.number(),
	cacheWriteInputTokens: z.number(),
	reasoningTokens: z.number(),
	webSearchRequests: z.number(),
	activeSeconds: z.number(),
	listCostMicroUsd: z.number().nullable(),
});

const sessionValidation = z.object({
	id: wireText,
	agentId: wireText,
	agentVersion: z.int().min(1),
	environmentId: wireText,
	environmentRevision: z.int().min(1),
	backend: wireText,
	title: wireNullableText,
	metadata: z.record(z.string(), z.string()),
	status: z.enum(MANAGED_AGENT_SESSION_STATUSES),
	stopReason: wireNullableText,
	pendingToolUseIds: z.array(wireText),
	lastError: z.object({ code: wireText, message: wireText }).nullable(),
	headSeq: wireCount,
	usage: usageValidation,
	billedMicroUsd: z.number(),
	budget: z.object({ maxCostMicroUsd: z.number() }).nullable(),
	closing: z
		.object({
			target: z.enum(["canceled", "completed"]),
			requestedAt: wireText,
		})
		.nullable(),
	createdAt: wireText,
	updatedAt: wireText,
	startedAt: wireNullableText,
	endedAt: wireNullableText,
});

const contentBlockValidation = z.union([
	z.object({ type: z.literal("text"), text: wireText }),
	z.object({ type: isUnknownTag(["text"]) }),
]);
const contentValidation = z.array(contentBlockValidation);

const envelopeValidation = z.object({
	id: wireText,
	sessionId: wireText,
	seq: z.int().min(1),
	createdAt: wireText,
	type: wireText,
});

const knownBodyValidation = z.discriminatedUnion("type", [
	z.object({ type: z.literal("user.message"), content: contentValidation }),
	z.object({ type: z.literal("user.interrupt") }),
	z.object({
		type: z.literal("user.custom_tool_result"),
		toolUseId: wireText,
		content: contentValidation,
		isError: z.boolean(),
	}),
	z.object({ type: z.literal("agent.message"), content: contentValidation }),
	z.object({
		type: z.literal("agent.message.delta"),
		messageKey: wireText,
		index: wireCount,
		text: wireText,
	}),
	z.object({
		type: z.literal("agent.tool_use"),
		toolUseId: wireText,
		name: wireText,
		input: wireJsonObject,
		inputTruncated: z.boolean(),
		source: wireText,
		server: wireNullableText,
	}),
	z.object({
		type: z.literal("agent.tool_result"),
		toolUseId: wireText,
		content: contentValidation,
		isError: z.boolean(),
		truncated: z.boolean(),
	}),
	z.object({
		type: z.literal("agent.custom_tool_use"),
		toolUseId: wireText,
		name: wireText,
		input: wireJsonObject,
	}),
	z.object({
		type: z.literal("agent.tool_approval_request"),
		toolUseId: wireText,
		name: wireText,
		source: wireText,
		server: wireNullableText,
		expiresAt: wireText,
	}),
	z.object({
		type: z.literal("user.tool_approval"),
		toolUseId: wireText,
		decision: wireText,
		message: wireNullableText,
	}),
	z.object({
		type: z.literal("session.status"),
		status: z.enum(MANAGED_AGENT_SESSION_STATUSES),
		stopReason: wireNullableText,
		pendingToolUseIds: z.array(wireText),
		detail: wireNullableText,
		inputSeq: z.int().min(1).nullish(),
	}),
	z.object({
		type: z.literal("session.error"),
		code: wireText,
		message: wireText,
		retryable: z.boolean(),
		source: wireText,
		details: wireRecord,
	}),
	z.object({
		type: z.literal("session.usage"),
		cumulative: usageValidation,
		delta: usageValidation,
		billing: z.object({ mode: wireText, amountMicroUsd: z.number() }),
	}),
]);

/** A well-formed event whose type this client version does not know. Clients ignore it. */
export interface ManagedAgentUnknownEvent extends ManagedAgentEventEnvelope {
	type: string;
	readonly [field: string]: ManagedAgentJsonValue;
}

/** A known event type with a valid body. Returns the raw event. */
export const managedAgentEventSchema = z.custom<ManagedAgentEvent>(
	(value) =>
		envelopeValidation.safeParse(value).success &&
		knownBodyValidation.safeParse(value).success
);

/**
 * An event whose type is not declared in v1 but whose envelope is valid and whose fields are
 * JSON. Returns the raw event.
 */
export const managedAgentUnknownEventSchema =
	z.custom<ManagedAgentUnknownEvent>((value) => {
		const envelope = envelopeValidation.safeParse(value);
		return (
			envelope.success &&
			!isKnownManagedAgentEventType(envelope.data.type) &&
			wireJsonObject.safeParse(value).success
		);
	});

/** A log entry: a valid known event, or an unknown type with a valid envelope and JSON fields. */
export const managedAgentAnyEventSchema = z.union([
	managedAgentEventSchema,
	managedAgentUnknownEventSchema,
]);

const eventListValidation = z.object({
	data: z.array(managedAgentAnyEventSchema),
	hasMore: z.boolean(),
	nextAfter: wireCount,
	headSeq: wireCount,
});

const appendedEventsValidation = z.object({
	data: z.array(managedAgentAnyEventSchema),
});

const errorBodyValidation = z.object({
	error: z.object({
		code: wireText,
		message: wireText,
		requestId: wireText,
		details: wireJsonObject.optional(),
	}),
});

const streamEndValidation = z.object({
	sessionId: wireText,
	status: z.enum(MANAGED_AGENT_SESSION_STATUSES),
	headSeq: wireCount,
	reason: wireText,
});

/** The §4.1 error envelope. An unknown `code` is accepted; branch on the HTTP status for it. */
export interface ManagedAgentsErrorEnvelope {
	error: {
		code: string;
		details?: ManagedAgentJsonObject;
		message: string;
		requestId: string;
	};
}

export const managedAgentSchema = z.custom<ManagedAgent>(
	(value) => agentValidation.safeParse(value).success
);
export const managedAgentVersionSchema = z.custom<ManagedAgentVersion>(
	(value) => agentVersionValidation.safeParse(value).success
);
export const managedAgentEnvironmentSchema = z.custom<ManagedAgentEnvironment>(
	(value) => environmentValidation.safeParse(value).success
);
export const managedAgentCredentialSchema = z.custom<ManagedAgentCredential>(
	(value) => credentialValidation.safeParse(value).success
);
export const managedAgentSessionSchema = z.custom<ManagedAgentSession>(
	(value) => sessionValidation.safeParse(value).success
);
/** The raw page; `data` may hold event types this client does not know. */
export const managedAgentEventListSchema = z.custom<ManagedAgentEventList>(
	(value) => eventListValidation.safeParse(value).success
);
/** The `202 {data: [...]}` reply of `POST /sessions/{sessionId}/events`. */
export const managedAgentAppendedEventsSchema = z.custom<{
	data: ManagedAgentEvent[];
}>((value) => appendedEventsValidation.safeParse(value).success);
/** Data of the SSE `event: end` frame. A future `reason` is accepted; stop reading either way. */
export const managedAgentStreamEndSchema = z.custom<ManagedAgentStreamEnd>(
	(value) => streamEndValidation.safeParse(value).success
);
export const managedAgentsErrorBodySchema =
	z.custom<ManagedAgentsErrorEnvelope>(
		(value) => errorBodyValidation.safeParse(value).success
	);

/** A collection page (`{data, nextCursor}`) whose every item passes `item`. Returns the raw page. */
export function managedAgentsListSchema<T>(item: z.ZodType<T>) {
	const pageValidation = z.object({
		data: z.array(item),
		nextCursor: wireNullableText,
	});
	return z.custom<ManagedAgentsList<T>>(
		(value) => pageValidation.safeParse(value).success
	);
}
