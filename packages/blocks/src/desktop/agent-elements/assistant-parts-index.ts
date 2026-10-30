import type { ToolPartBase } from "./message-list-types.ts";
import { extractCitations } from "./utils/citations.ts";
import { nativeOptionalSdkText } from "./utils/live-media-observations.ts";
import { getFailoverNote } from "./utils/live-message-flags.ts";
import {
	isV5SdkToolPart as isV5ToolPart,
	type RenderedSdkPart,
	type SdkToolPart,
} from "./utils/sdk-tool-observations.ts";

/**
 * What AssistantParts reads from a message's whole part list before it draws
 * any part: the citations, the tool calls nested under a Task or Agent call,
 * and the failover notes whose plain-text twins are dropped.
 */
export function indexAssistantParts(
	parts: RenderedSdkPart[],
	groupToolUses: boolean,
	hideToolDetail: boolean
) {
	// Extract once so text parts can render inline `[n]` chips against the
	// same numbered list shown in the sources footer. Read from the FULL part
	// list, before any detail filtering: the chips are numbered against this
	// list, so extracting from a filtered one would point `[2]` at a source
	// that is no longer there. Citations survive Detail level "None" — they
	// are part of the reply, not a tool row.
	const citations = extractCitations(parts);
	const taskPartIds = new Set(
		parts
			.filter(
				(p): p is SdkToolPart =>
					isV5ToolPart(p) &&
					(p.type === "tool-Task" || p.type === "tool-Agent") &&
					nativeOptionalSdkText(p.toolCallId) !== undefined
			)
			.map((p) => p.toolCallId)
	);
	const nestedToolsMap = new Map<string, ToolPartBase[]>();
	const nestedToolIds = new Set<string>();
	// Reactive-failover verdicts, collected up front so the PLAIN-TEXT TWIN
	// of each one can be dropped below. Core deliberately emits both: the
	// structured `data-ryu-failover` part for anything that can read data
	// frames, and the same `note` as an ordinary text block because
	// `/api/chat/stream` is not desktop-only — the TUI, the native app and the
	// island all POST to it and none of them renders `data-*`. So the twin
	// stays on the wire (removing it would silently strip the explanation from
	// those surfaces); it is suppressed HERE, where the structured part is
	// about to be drawn as a Marker instead.
	const failoverNotes = new Set<string>();
	for (const part of parts) {
		const note = getFailoverNote(part);
		if (note) {
			failoverNotes.add(note);
		}
	}

	// Only collect nested tools into the parent group when grouping is on.
	// When off, every tool renders individually (nestedToolIds stays empty so
	// the skip-check at render time doesn't hide them).
	//
	// Detail level "None" also switches grouping off, and not as a shortcut:
	// the only tool rows that survive None are the FAILED ones, and rolling a
	// failed child into a hidden parent would swallow the failure entirely.
	// With grouping off, every failed call is judged on its own.
	if (groupToolUses && !hideToolDetail) {
		for (const part of parts) {
			if (!isV5ToolPart(part)) {
				continue;
			}
			if (part.type === "tool-TaskOutput") {
				continue;
			}
			if (!part.toolCallId?.includes(":")) {
				continue;
			}
			const parentId = part.toolCallId.split(":")[0];
			if (!(parentId && taskPartIds.has(parentId))) {
				continue;
			}
			if (!nestedToolsMap.has(parentId)) {
				nestedToolsMap.set(parentId, []);
			}
			nestedToolsMap.get(parentId)?.push(part);
			nestedToolIds.add(part.toolCallId);
		}
	}
	return { citations, nestedToolsMap, nestedToolIds, failoverNotes };
}
