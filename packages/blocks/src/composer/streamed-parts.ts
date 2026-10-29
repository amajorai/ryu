import {
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import { nativeSdkSchemaAdmits } from "../desktop/agent-elements/utils/native-sdk-admission.ts";
import type { NativeSdkValue } from "../desktop/agent-elements/utils/native-sdk-observation.ts";
// Side-channel parts Core streams alongside the reply.
//
// Three `data-*` parts are NOT transcript content — they drive client state:
//
//   `data-ryu-acp-mode`     the agent switched the session's permission mode
//   `data-ryu-acp-config`   the agent asked the client to change session config
//                           it holds and re-sends every turn (an approved
//                           ExitPlanMode clearing the Plan pill is the shipped case)
//   `data-plugin_note`      a server-side turn-hook note (goal/proof/double-check)
//
// They land in `message.parts` like everything else, so any surface driving the
// chat through an AI SDK transport reads them the same way: scan back from the
// newest message. These helpers are that scan, shared so the island and the
// desktop cannot disagree about it.
//
// Both `data-ryu-acp-config` and `data-plugin_note` are keyed by EMISSION
// (`messageId:partIndex`), not by value. An agent re-emits the byte-identical
// `{"ryu.plan":"off"}` on a second plan cycle, and a value-keyed guard would
// swallow it and leave the Plan pill armed — the exact bug the channel exists to
// fix. A re-derive over the same messages yields the same key, so an effect
// guarding on it no-ops mid-stream instead of stomping a manual pick.

/** The subset of a UIMessage these scans need — kept structural so the helpers
 *  work against the native AI SDK UIMessage while allowing legacy parts. */
export interface StreamedPartsMessage {
	id: string;
	parts?: NativeSdkValue[];
	role: string;
}

/** An emission of a keyed side-channel part. */
export interface StreamedEmission<T> {
	/** `messageId:partIndex` — the identity to dedupe on. */
	key: string;
	value: T;
}

interface StreamedPartObservation {
	readonly config?: NativeSdkValue;
	readonly currentModeId?: NativeSdkValue;
	readonly data?: NativeSdkValue;
	readonly text?: NativeSdkValue;
	readonly type?: NativeSdkValue;
}

const streamedPartObjectSchema =
	z.custom<StreamedPartObservation>(isNativeObjectLike);

function isRecord(value: NativeSdkValue): value is StreamedPartObservation {
	return nativeSdkSchemaAdmits(streamedPartObjectSchema, value);
}

/**
 * Walk assistant parts newest-first, calling `read` on each part of `type`.
 * The first non-null result wins.
 */
function findLatestPart<T>(
	messages: readonly StreamedPartsMessage[],
	type: string,
	read: (data: NativeSdkValue) => T | null
): StreamedEmission<T> | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role !== "assistant" || !message.parts) {
			continue;
		}
		for (let j = message.parts.length - 1; j >= 0; j -= 1) {
			const part = message.parts[j];
			if (!isRecord(part) || part.type !== type) {
				continue;
			}
			const value = read(part.data);
			if (value !== null) {
				return { key: `${message.id}:${j}`, value };
			}
		}
	}
	return null;
}

/** The most recent agent-initiated permission-mode switch, or null. */
export function latestStreamedAcpMode(
	messages: readonly StreamedPartsMessage[]
): string | null {
	return (
		findLatestPart(messages, "data-ryu-acp-mode", (data) => {
			const modeId = isRecord(data) ? data.currentModeId : undefined;
			const trimmed = isNativeText(modeId) ? modeId.trim() : "";
			return trimmed.length > 0 ? trimmed : null;
		})?.value ?? null
	);
}

/** The most recent agent-requested session-config write-back, or null. */
export function latestStreamedAcpConfig(
	messages: readonly StreamedPartsMessage[]
): StreamedEmission<Record<string, string>> | null {
	return findLatestPart(messages, "data-ryu-acp-config", (data) => {
		const config = isRecord(data) ? data.config : undefined;
		if (!(isRecord(config) && Object.keys(config).length > 0)) {
			return null;
		}
		// SAFETY: Core emits this named config channel from AcpEvent::ConfigUpdate(BTreeMap<String, String>); pi_config_updates drops each non-string value before mod.rs serializes { config: updates }. The existing object/nonempty guard handles absent frames and the original map identity is retained.
		return config as Record<string, string>;
	});
}

/** The most recent turn-hook note, or null. Surfaced in a dismissible banner —
 *  never as an assistant reply. */
export function latestPluginNote(
	messages: readonly StreamedPartsMessage[]
): StreamedEmission<string> | null {
	return findLatestPart(messages, "data-plugin_note", (data) => {
		const text = isRecord(data) ? data.text : undefined;
		const trimmed = isNativeText(text) ? text.trim() : "";
		return trimmed.length > 0 ? trimmed : null;
	});
}
