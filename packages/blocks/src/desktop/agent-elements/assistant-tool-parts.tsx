import type React from "react";
import type { AssistantPartsProps } from "./assistant-parts-types.ts";
import { isAgentMessageSdkPart } from "./message-list-helpers.ts";
import type { ToolPartBase } from "./message-list-types.ts";
import { isHiddenAtNoDetail } from "./tool-detail-visibility.ts";
import { AgentMessagesMarker } from "./tools/agent-messages-marker.tsx";
import { ToolGroup } from "./tools/tool-group.tsx";
import { isToolActivityGroupCandidate } from "./tools/tool-grouping.ts";
import { ToolRenderer as DefaultToolRenderer } from "./tools/tool-renderer.tsx";
import type {
	RenderedSdkPart,
	SdkToolPart,
} from "./utils/sdk-tool-observations.ts";
import { isV5SdkToolPart as isV5ToolPart } from "./utils/sdk-tool-observations.ts";

/** What drawing one tool part needs from the AssistantParts element memo. */
export interface AssistantToolPartContext
	extends Pick<
		AssistantPartsProps,
		| "agentMessageContext"
		| "isLast"
		| "isStreaming"
		| "msg"
		| "onAgentUiSubmit"
		| "suppressQuestionTool"
		| "ToolRendererComponent"
		| "toolRenderers"
	> {
	expandCommands: boolean;
	expandFileEdits: boolean;
	groupToolUses: boolean;
	hideToolDetail: boolean;
	nestedToolIds: Set<string>;
	nestedToolsMap: Map<string, ToolPartBase[]>;
	parts: RenderedSdkPart[];
	pushPart: (node: React.ReactNode, isText?: boolean) => void;
	sentAt: Date | undefined;
}

/**
 * Draw the tool part at `i` (alone, as an agent-message run, or as a tool
 * activity group) and return the index of the next part to draw.
 */
export function pushAssistantToolPart(
	{
		agentMessageContext,
		expandCommands,
		expandFileEdits,
		groupToolUses,
		hideToolDetail,
		isLast,
		isStreaming,
		msg,
		nestedToolIds,
		nestedToolsMap,
		onAgentUiSubmit,
		parts,
		pushPart,
		sentAt,
		suppressQuestionTool,
		ToolRendererComponent,
		toolRenderers,
	}: AssistantToolPartContext,
	part: SdkToolPart,
	i: number
): number {
	if (suppressQuestionTool && part.type === "tool-Question") {
		return i + 1;
	}
	if (part.toolCallId && nestedToolIds.has(part.toolCallId)) {
		return i + 1;
	}
	// Detail level "None": no tool rows, no file edits, no thinking
	// traces — only the calls that FAILED, because a turn that died
	// silently is worse than a turn that shows one row.
	if (hideToolDetail && isHiddenAtNoDetail(part)) {
		return i + 1;
	}

	const chatStreamingStatus = isLast && isStreaming ? "streaming" : undefined;
	// Agent-to-agent sends fold into ONE "Messaged N agents" marker per
	// run, so a fan-out to seven peers reads as one line, not seven
	// bubbles; each exchange opens from the marker. A host-supplied
	// renderer still sees every call on its own.
	if (
		ToolRendererComponent === DefaultToolRenderer &&
		isAgentMessageSdkPart(part)
	) {
		const run: SdkToolPart[] = [part];
		let nextIndex = i + 1;
		while (nextIndex < parts.length) {
			const nextPart = parts[nextIndex];
			if (
				!(isV5ToolPart(nextPart) && isAgentMessageSdkPart(nextPart)) ||
				(hideToolDetail && isHiddenAtNoDetail(nextPart))
			) {
				break;
			}
			run.push(nextPart);
			nextIndex += 1;
		}
		pushPart(
			<AgentMessagesMarker
				chatStatus={chatStreamingStatus}
				context={agentMessageContext}
				key={part.toolCallId ?? `${msg.id}-agent-messages-${i}`}
				parts={run}
				sentAt={sentAt}
			/>
		);
		return nextIndex;
	}
	const groupOptions = { expandCommands, expandFileEdits };
	if (
		groupToolUses &&
		ToolRendererComponent === DefaultToolRenderer &&
		isToolActivityGroupCandidate(part, groupOptions)
	) {
		const groupedParts: ToolPartBase[] = [part];
		let nextIndex = i + 1;
		while (nextIndex < parts.length) {
			const nextPart = parts[nextIndex];
			if (
				!isV5ToolPart(nextPart) ||
				(nextPart.toolCallId !== undefined &&
					nestedToolIds.has(nextPart.toolCallId)) ||
				!isToolActivityGroupCandidate(nextPart, groupOptions)
			) {
				break;
			}
			groupedParts.push(nextPart);
			nextIndex += 1;
		}

		if (groupedParts.length > 1) {
			pushPart(
				<ToolGroup
					chatStatus={chatStreamingStatus}
					key={`${msg.id}-tool-group-${i}`}
					parts={groupedParts}
				/>
			);
			return nextIndex;
		}
	}
	const toolCallId = part.toolCallId;
	const nestedTools =
		(part.type === "tool-Task" || part.type === "tool-Agent") && toolCallId
			? nestedToolsMap.get(toolCallId) || []
			: undefined;
	pushPart(
		<ToolRendererComponent
			agentMessageContext={agentMessageContext}
			chatStatus={chatStreamingStatus}
			key={part.toolCallId ?? `${msg.id}-tool-${i}`}
			nestedTools={nestedTools}
			onAgentUiSubmit={onAgentUiSubmit}
			part={part}
			toolRenderers={toolRenderers}
		/>
	);
	return i + 1;
}
