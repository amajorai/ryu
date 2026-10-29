import {
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import { nativeSdkSchemaAdmits } from "../utils/native-sdk-admission.ts";
import type { NativeSdkValue } from "../utils/native-sdk-observation.ts";
import { unwrapMcpOutput } from "../utils/unwrap-mcp-output.ts";

export interface AgentMessageToolPart {
	input?: NativeSdkValue;
	output?: NativeSdkValue;
	result?: NativeSdkValue;
	state?: string;
	toolCallId?: string;
	toolName?: string;
	type?: string;
}

export type AgentMessageKind = "ask" | "send";

export interface AgentMessagePayload {
	from?: string;
	kind: AgentMessageKind;
	reply?: string;
	text: string;
	to: string;
}

/** Consumed argument/reply cells, not a full agents.send/ask DTO. Values stay
 * in the actual SDK opaque domain until the existing string observation. */
interface AgentMessageObservation {
	from?: NativeSdkValue;
	question?: NativeSdkValue;
	reply?: NativeSdkValue;
	text?: NativeSdkValue;
	to?: NativeSdkValue;
}
const agentMessageObservationSchema =
	z.custom<AgentMessageObservation>(isNativeObjectLike);
function isRecord(value: NativeSdkValue): value is AgentMessageObservation {
	return nativeSdkSchemaAdmits(agentMessageObservationSchema, value);
}

function readString(
	record: AgentMessageObservation | null,
	key: keyof AgentMessageObservation
) {
	const value = record?.[key];
	return isNativeText(value) && value.trim() ? value.trim() : undefined;
}

export function readAgentMessageOutput(
	part: AgentMessageToolPart
): NativeSdkValue {
	if (part.output !== undefined && part.output !== null) {
		return unwrapMcpOutput(part.output);
	}
	return part.result === undefined ? undefined : unwrapMcpOutput(part.result);
}

/** Recognize both MCP wire parts and the AI SDK's dynamic-tool form. */
export function isAgentMessageToolPart(
	partType: string,
	toolName?: string
): boolean {
	return (
		toolName === "agents.send" ||
		toolName === "agents.ask" ||
		partType === "tool-agents.send" ||
		partType === "tool-agents.ask" ||
		partType.endsWith(".agents.send") ||
		partType.endsWith(".agents.ask")
	);
}

function messageKind(part: AgentMessageToolPart): AgentMessageKind {
	const type = part.type ?? "";
	return part.toolName === "agents.ask" ||
		type === "tool-agents.ask" ||
		type.endsWith(".agents.ask")
		? "ask"
		: "send";
}

/** Read send/ask arguments and the host-derived sender from a tool part. */
export function readAgentMessagePayload(
	part: AgentMessageToolPart
): AgentMessagePayload | null {
	const kind = messageKind(part);
	const input = unwrapMcpOutput(part.input);
	const inputRecord = isRecord(input) ? input : null;
	const output = readAgentMessageOutput(part);
	const outputRecord = isRecord(output) ? output : null;
	const to = readString(inputRecord, "to") ?? readString(outputRecord, "to");
	const text =
		(kind === "ask"
			? (readString(inputRecord, "question") ??
				readString(outputRecord, "question"))
			: (readString(inputRecord, "text") ??
				readString(outputRecord, "text"))) ??
		readString(inputRecord, "text") ??
		readString(outputRecord, "text");
	if (!(to && text)) {
		return null;
	}
	return {
		from: readString(outputRecord, "from"),
		kind,
		reply: kind === "ask" ? readString(outputRecord, "reply") : undefined,
		text,
		to,
	};
}

/** Ok-flag cell of an agents.send/ask reply; only the refusal check reads it. */
interface AgentDeliveryObservation {
	ok?: NativeSdkValue;
}
const agentDeliveryObservationSchema =
	z.custom<AgentDeliveryObservation>(isNativeObjectLike);

/** Switchboard answers a refused send (hop limit, unknown peer) with `ok:false`
 * rather than a tool error, so a completed call can still be undelivered. */
export function isAgentMessageRefused(part: AgentMessageToolPart): boolean {
	const output = readAgentMessageOutput(part);
	return (
		nativeSdkSchemaAdmits(agentDeliveryObservationSchema, output) &&
		output.ok === false
	);
}

export type AgentMessageDelivery = "failed" | "sending" | "sent";

/** Delivery state of one send/ask call. `chatStatus` is the message list's
 * `"streaming"` flag: an unfinished call outside a live turn was interrupted. */
export function agentMessageDelivery(
	part: AgentMessageToolPart,
	chatStatus?: string
): AgentMessageDelivery {
	if (part.state === "output-error" || isAgentMessageRefused(part)) {
		return "failed";
	}
	if (part.state === "output-available") {
		return "sent";
	}
	return chatStatus === "streaming" ? "sending" : "failed";
}

export interface AgentMessageExchangeEntry {
	delivery: AgentMessageDelivery;
	/** Stable per call: the tool call id, else the peer and call position. */
	key: string;
	payload: AgentMessagePayload;
}

/** Everything one sender said to one peer inside a run of send/ask calls. */
export interface AgentPeerConversation {
	delivery: AgentMessageDelivery;
	entries: AgentMessageExchangeEntry[];
	/** Host-derived sender id, when any reply in the run carried one. */
	from?: string;
	peer: string;
}

export interface AgentMessageRunSummary {
	peers: AgentPeerConversation[];
	/** Calls whose recipient/text have not streamed in yet. */
	unreadable: { delivery: AgentMessageDelivery }[];
}

function worstDelivery(
	left: AgentMessageDelivery,
	right: AgentMessageDelivery
): AgentMessageDelivery {
	if (left === "failed" || right === "failed") {
		return "failed";
	}
	return left === "sending" || right === "sending" ? "sending" : "sent";
}

/**
 * Fold a run of agents.send/ask calls into one conversation per recipient, in
 * first-contact order, so the transcript can show "Messaged N agents" once
 * instead of a bubble per call. A peer's delivery is its worst call's state:
 * one refused message to a peer is worth surfacing even if a later one landed.
 */
export function summarizeAgentMessageRun(
	parts: readonly AgentMessageToolPart[],
	chatStatus?: string
): AgentMessageRunSummary {
	const peers = new Map<string, AgentPeerConversation>();
	const unreadable: { delivery: AgentMessageDelivery }[] = [];
	for (const part of parts) {
		const delivery = agentMessageDelivery(part, chatStatus);
		const payload = readAgentMessagePayload(part);
		if (!payload) {
			unreadable.push({ delivery });
			continue;
		}
		const existing = peers.get(payload.to);
		const key =
			part.toolCallId ??
			`${payload.to}:${existing ? existing.entries.length : 0}`;
		if (existing) {
			existing.entries.push({ delivery, key, payload });
			existing.delivery = worstDelivery(existing.delivery, delivery);
			existing.from ??= payload.from;
			continue;
		}
		peers.set(payload.to, {
			delivery,
			entries: [{ delivery, key, payload }],
			from: payload.from,
			peer: payload.to,
		});
	}
	return { peers: [...peers.values()], unreadable };
}
