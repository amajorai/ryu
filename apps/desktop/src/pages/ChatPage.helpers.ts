import type { MessageReadReceiptState } from "@ryu/blocks/desktop/agent-elements/message-read-receipt.tsx";
import type { MessageActionRuntimeState } from "@ryu/blocks/desktop/agent-elements/types.ts";
import { nativeSdkSchemaAdmits } from "@ryu/blocks/desktop/agent-elements/utils/native-sdk-admission.ts";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import type { UIMessage } from "ai";
import { z } from "zod";
import type { ChatSearchMode } from "@/src/components/chat/ChatSearchBar.tsx";
import { type ApiTarget, apiUrl, makeHeaders } from "@/src/lib/api/client.ts";
import type {
	ConversationContextHandoff,
	ConversationModelChange,
} from "@/src/lib/api/conversation-model-selection.ts";
import type { SlashCommand } from "@/src/lib/slash-commands.ts";

export interface ChatSearchState {
	mode: ChatSearchMode;
	nonce: number;
	open: boolean;
	query: string;
}

// How often the focused chat tab re-probes `/api/chat/stream/resume/:id` while it
// believes it is idle. The endpoint 404s in-memory when nothing is running, so
// this is deliberately cheap; the interval only has to be short enough that Stop
// appears promptly for a turn this tab did not start.
export const realtimeEventInputSchema = z.record(z.string(), z.json());

export const RESUME_POLL_MS = 15_000;

// How long after an explicit Stop the resume probe stays quiet, so a turn Core
// is still tearing down cannot re-arm the composer's Stop button.
export const RESUME_STOP_GRACE_MS = 5000;

// Cool-down after a resumed reader detaches, so the "stream ended" → "ready"
// transition cannot re-probe in a tight loop.
export const RESUME_REATTACH_GRACE_MS = 1500;

// Stream render cadence. The focused pane stays smooth. Unfocused panes can
// still be on screen in a split or on the canvas, so they update a few times a
// second instead of per chunk rather than dropping to a crawl.
export const ACTIVE_TAB_STREAM_THROTTLE_MS = 50;

export const BACKGROUND_TAB_STREAM_THROTTLE_MS = 250;

// Idle gap after the last keystroke before we broadcast `typing:false` to the
// conversation room (multi-user presence).
export const TYPING_IDLE_MS = 2500;

// Hoisted so the identity is stable. Passed inline as `{}` this is a dependency
// of the memo that builds every assistant message's element tree, so a fresh
// object rebuilds the ENTIRE transcript (markdown, tool rows, citations) on
// every render of this page.
export const EMPTY_TOOL_RENDERERS: Record<string, never> = {};

export interface StreamedTurnControl {
	effort?: string;
	phase: "answering" | "reasoning";
	startedAtMs: number;
	strategy: "native";
	turnId: string;
}

export const ARTIFACTS_SPACE_NAME = "Artifacts";

export interface SavedPlanDocument {
	documentId: string;
	spaceId: string;
}

/** Ryu's own composer commands, always offered alongside agent-advertised ones.
 *  Plugin-owned commands are supplied by `pluginContributions.slash_commands` so
 *  disabling a plugin removes both its discoverability and its handler. */
export const LOCAL_SLASH_COMMANDS: SlashCommand[] = [
	{
		args: [],
		name: "goal",
		description: "Set a goal the agent works toward each turn",
		hint: "condition to watch for",
		source: "local",
	},
	{
		args: [],
		name: "rewind",
		description: "Restore code and/or conversation to before a message",
		source: "local",
	},
];

// ---------------------------------------------------------------------------
/**
 * Build the per-request `plugin_flags` map from the plugin composer toggles that
 * are currently ON (plus any one-shot `action` flag fired for this turn). Every
 * composer control (including the built-in double-check toggle, which is now a
 * plugin contribution like any other) flows through this one generic map keyed by
 * each control's `flag`. Returns `undefined` when nothing is on so Core applies
 * its defaults.
 *
 * The map is BOOL-ONLY on purpose: Core's `ChatRequest::plugin_flags` is a
 * `HashMap<String, bool>`, so a string value would fail to deserialize and take
 * the whole turn down with it. A `select`/`chip` value therefore lives in the
 * composer's own `pluginControlValues` state and does NOT reach the turn until
 * Core widens that field to a JSON value.
 */
export function buildPluginFlags(
	pluginFlags: Record<string, boolean>
): Record<string, boolean> | undefined {
	const merged: Record<string, boolean> = {};
	for (const [flag, on] of Object.entries(pluginFlags)) {
		if (on) {
			merged[flag] = true;
		}
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}

// legacy component
/** Fetch a created artifact's blob as text through the node API (best-effort:
 *  a failed fetch yields null, and the surface falls back to the download/open
 *  affordance rather than an error state). */
export async function fetchArtifactContent(
	target: ApiTarget,
	url: string
): Promise<string | null> {
	try {
		const res = await fetch(apiUrl(target, url), {
			headers: makeHeaders(target.token, target.userJwt),
		});
		if (!res.ok) {
			return null;
		}
		return await res.text();
	} catch {
		return null;
	}
}

/** Opaque optional native slots only; no complete author or metadata DTO claim.
 * Lodash's installed object-like classifier owns the exact non-null `typeof
 * object` brand, including arrays and revoked Proxy receivers. Raw parser
 * observation never finalizes rejected inputs through a user error map. */
export interface NativeAuthorMetadataLookup {
	readonly author?: UIMessage["metadata"];
}

export interface NativeAuthorIdLookup {
	readonly id?: UIMessage["metadata"];
}

export const authorMetadataSchema =
	z.custom<NativeAuthorMetadataLookup>(isNativeObjectLike);

export const authorIdSchema =
	z.custom<NativeAuthorIdLookup>(isNativeObjectLike);

export function isNativeAuthorMetadata(
	value: UIMessage["metadata"]
): value is NativeAuthorMetadataLookup {
	return nativeSdkSchemaAdmits(authorMetadataSchema, value);
}

export function isNativeAuthorIdCarrier(
	value: UIMessage["metadata"]
): value is NativeAuthorIdLookup {
	return nativeSdkSchemaAdmits(authorIdSchema, value);
}

export function messageAuthorId(message: UIMessage): string | null {
	const metadata = message.metadata;
	if (!isNativeAuthorMetadata(metadata)) {
		return null;
	}
	const author = metadata.author;
	if (!isNativeAuthorIdCarrier(author)) {
		return null;
	}
	const id = author.id;
	return isNativeText(id) && id.trim() ? id.trim() : null;
}

export function mergeContextHandoffs(
	current: ConversationContextHandoff[],
	incoming: ConversationContextHandoff[]
): ConversationContextHandoff[] {
	// One marker per model change: an edit before the switch hands the new
	// branch off separately, and the latest one Core sends is the thread's.
	const byChange = new Map(
		current.map((handoff) => [handoff.modelChangeId, handoff])
	);
	for (const handoff of incoming) {
		byChange.set(handoff.modelChangeId, handoff);
	}
	return [...byChange.values()].sort(
		(left, right) => left.createdAt - right.createdAt
	);
}

/** "1M", "256K", "8K": a context window as people say it. */
export function formatContextWindow(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${Number((tokens / 1_000_000).toFixed(1))}M`;
	}
	return `${Math.round(tokens / 1000)}K`;
}

export function describeContextHandoff(
	handoff: ConversationContextHandoff,
	tl: LiteralMessage
): string {
	const messages = tl(
		"{summarizedCount} earlier {count, plural, one {message} other {messages}} summarized",
		{
			count: handoff.summarizedCount,
			summarizedCount: String(handoff.summarizedCount),
		}
	);
	const target = handoff.toModel ? ` for ${handoff.toModel}` : "";
	const windows =
		handoff.fromContext !== null && handoff.toContext !== null
			? ` · ${formatContextWindow(handoff.fromContext)} → ${formatContextWindow(handoff.toContext)} context`
			: "";
	return `${messages}${target}${windows}`;
}

export function mergeConversationModelChanges(
	current: ConversationModelChange[],
	incoming: ConversationModelChange[]
): ConversationModelChange[] {
	const byId = new Map(current.map((change) => [change.id, change]));
	for (const change of incoming) {
		byId.set(change.id, change);
	}
	return [...byId.values()].sort(
		(left, right) => left.sequence - right.sequence
	);
}

/**
 * Keep last render's receipt object for every message whose readers did not
 * change. The receipts are rebuilt from the transcript on each streamed chunk,
 * and the transcript memoises each settled turn on its receipt's identity.
 */
export function reuseUnchangedReadReceipts(
	previous: ReadonlyMap<string, MessageReadReceiptState>,
	next: Map<string, MessageReadReceiptState>
): Map<string, MessageReadReceiptState> {
	for (const [messageId, state] of next) {
		const prior = previous.get(messageId);
		if (
			prior &&
			prior.delivered === state.delivered &&
			prior.readers.length === state.readers.length &&
			prior.readers.every((reader, index) => {
				const other = state.readers[index];
				return (
					reader.id === other?.id &&
					reader.name === other.name &&
					reader.avatar === other.avatar
				);
			})
		) {
			next.set(messageId, prior);
		}
	}
	return next;
}

function sameToggleValues(
	left: MessageActionRuntimeState["toggleValues"],
	right: MessageActionRuntimeState["toggleValues"]
): boolean {
	if (left === right) {
		return true;
	}
	if (!(left && right)) {
		return false;
	}
	const leftKeys = Object.keys(left);
	return (
		leftKeys.length === Object.keys(right).length &&
		leftKeys.every((key) => left[key] === right[key])
	);
}

/**
 * Keep last render's action-state object for every message whose reactions,
 * memory citations and toggle values are the same. The states are rebuilt on
 * each streamed chunk (citations are read off the transcript), and the
 * transcript memoises each settled turn on its action state's identity.
 */
export function reuseUnchangedActionStates(
	previous: ReadonlyMap<string, MessageActionRuntimeState>,
	next: Map<string, MessageActionRuntimeState>
): Map<string, MessageActionRuntimeState> {
	for (const [messageId, state] of next) {
		const prior = previous.get(messageId);
		if (
			prior &&
			prior.reactionBuckets === state.reactionBuckets &&
			prior.memoryCitations === state.memoryCitations &&
			sameToggleValues(prior.toggleValues, state.toggleValues)
		) {
			next.set(messageId, prior);
		}
	}
	return next;
}
