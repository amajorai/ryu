import { z } from "zod";

// Pure helpers for the inline **session card**: how a coordinator's
// `threads.create_thread` / `threads.send_message_to_thread` call is shown in
// the main thread's transcript. Sessions are not sidebar rows, so this card is
// how the user sees (and opens) the work the main thread delegated.

/**
 * Fired on `window` to ask the host to open a conversation. The blocks package
 * cannot reach the desktop's tab system, so the card raises this and the shell
 * listens (`useOpenConversationEvents`).
 */
export const OPEN_CONVERSATION_EVENT = "ryu:open-conversation";

export interface OpenConversationDetail {
	conversationId: string;
	title?: string;
}

/** The complete named event published by requestOpenConversation. */
export type OpenConversationEvent = CustomEvent<OpenConversationDetail>;

declare global {
	interface WindowEventMap {
		"ryu:open-conversation": OpenConversationEvent;
	}
}

const SESSION_TOOLS = ["create_thread", "send_message_to_thread"] as const;

type SessionToolName = (typeof SESSION_TOOLS)[number];

/** The `threads.*` verb a part calls, if it is a session tool. Tolerates the
 * registry id (`threads.create_thread`), the typed part form
 * (`tool-threads.create_thread`) and MCP-prefixed ids (`<server>.threads.x`). */
export function sessionToolVerb(
	partType: string,
	toolName?: string
): SessionToolName | null {
	const candidates = [toolName ?? "", partType];
	for (const candidate of candidates) {
		for (const verb of SESSION_TOOLS) {
			if (
				candidate === `threads.${verb}` ||
				candidate === `tool-threads.${verb}` ||
				candidate.endsWith(`.threads.${verb}`) ||
				candidate.endsWith(`threads__${verb}`)
			) {
				return verb;
			}
		}
	}
	return null;
}

export function isSessionToolPart(
	partType: string,
	toolName?: string
): boolean {
	return sessionToolVerb(partType, toolName) !== null;
}

export type SessionCardStatus = "starting" | "running" | "done" | "failed";

export interface SessionCardModel {
	agentId: string | null;
	/** One line of the latest reply, when the call waited for one. */
	latest: string | null;
	status: SessionCardStatus;
	threadId: string | null;
	title: string;
	verb: SessionToolName;
}

/** Native tool payload fields are read independently; unrelated data remains opaque. */
interface SessionPayloadCarrier {
	agent_id?: unknown;
	content?: unknown;
	message?: unknown;
	ok?: unknown;
	reply?: unknown;
	text?: unknown;
	thread_id?: unknown;
	title?: unknown;
}

const sessionNativeCarrierSchema = z.custom<SessionPayloadCarrier>(
	(value) => Array.isArray(value) || z.object({}).safeParse(value).success
);
const sessionStringSchema = z.string();
const sessionPayloadSchema = z
	.unknown()
	.transform((value): SessionPayloadCarrier => {
		let decoded = value;
		const encoded = sessionStringSchema.safeParse(value);
		if (encoded.success) {
			try {
				decoded = JSON.parse(encoded.data);
			} catch {
				return {};
			}
		}
		const carrier = sessionNativeCarrierSchema.safeParse(decoded);
		return carrier.success ? carrier.data : {};
	});
const sessionTextContentSchema = z.custom<SessionPayloadCarrier>((value) => {
	const carrier = sessionNativeCarrierSchema.safeParse(value);
	return carrier.success && "text" in carrier.data;
});

function record(
	value: Parameters<typeof sessionPayloadSchema.safeParse>[0]
): SessionPayloadCarrier {
	return sessionPayloadSchema.parse(value);
}

function text(
	value: Parameters<typeof sessionStringSchema.safeParse>[0]
): string | null {
	const parsed = sessionStringSchema.safeParse(value);
	return parsed.success && parsed.data.trim() ? parsed.data.trim() : null;
}

/** Unwrap an MCP `{ content: [{ type: "text", text }] }` envelope. */
function unwrapOutput(
	output: Parameters<typeof sessionPayloadSchema.safeParse>[0]
): SessionPayloadCarrier {
	const direct = record(output);
	const content = direct.content;
	if (Array.isArray(content)) {
		let first: SessionPayloadCarrier | undefined;
		content.find((item) => {
			const envelope = sessionTextContentSchema.safeParse(item);
			if (envelope.success) {
				first = envelope.data;
			}
			return envelope.success;
		});
		if (first) {
			return record(first.text);
		}
	}
	return direct;
}

function firstLine(value: string | null, max = 140): string | null {
	if (!value) {
		return null;
	}
	const line =
		value
			.split("\n")
			.find((part) => part.trim())
			?.trim() ?? "";
	if (!line) {
		return null;
	}
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Build the card from a tool part (`{ type, toolName, state, input, output }`). */
export function sessionCardModel(part: {
	errorText?: unknown;
	input?: unknown;
	output?: unknown;
	state?: string;
	toolName?: string;
	type?: string;
}): SessionCardModel | null {
	const verb = sessionToolVerb(part.type ?? "", part.toolName);
	if (!verb) {
		return null;
	}
	const input = record(part.input);
	const output = unwrapOutput(part.output);
	const threadId = text(output.thread_id) ?? text(input.thread_id);
	const failed =
		part.state === "output-error" ||
		output.ok === false ||
		Boolean(part.errorText);
	const reply = text(output.reply);
	let status: SessionCardStatus;
	if (failed) {
		status = "failed";
	} else if (part.state !== "output-available") {
		status = "starting";
	} else if (reply) {
		status = "done";
	} else {
		status = verb === "create_thread" ? "starting" : "running";
	}
	return {
		agentId: text(output.agent_id) ?? text(input.agent_id),
		latest: firstLine(reply ?? text(input.message)),
		status,
		threadId,
		title: text(output.title) ?? text(input.title) ?? "Session",
		verb,
	};
}

/** Ask the host to open a conversation (see {@link OPEN_CONVERSATION_EVENT}). */
export function requestOpenConversation(detail: OpenConversationDetail): void {
	if (globalThis.window === undefined) {
		return;
	}
	window.dispatchEvent(
		new CustomEvent<OpenConversationDetail>(OPEN_CONVERSATION_EVENT, {
			detail,
		})
	);
}
