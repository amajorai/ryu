import { ArrowDataTransferHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	type CitationItem,
	CitationList,
} from "@ryu/ui/components/agents/citations";
import { BubbleContent } from "@ryu/ui/components/bubble";
import { Marker, MarkerContent, MarkerIcon } from "@ryu/ui/components/marker";
import type React from "react";
import { useMemo } from "react";
import {
	AssistantGeneratedImage,
	AssistantGeneratedVideo,
} from "./assistant-generated-media.tsx";
import { foldAssistantProse } from "./assistant-parts-fold.tsx";
import { indexAssistantParts } from "./assistant-parts-index.ts";
import type { AssistantPartsProps } from "./assistant-parts-types.ts";
import {
	type AssistantToolPartContext,
	pushAssistantToolPart,
} from "./assistant-tool-parts.tsx";
import { useChatDisplayPrefs } from "./chat-display-prefs.tsx";
import { ErrorMessage } from "./error-message.tsx";
import { FileAttachment } from "./input/file-attachment.tsx";
import { Markdown } from "./markdown.tsx";
import { hostnameOfCitation } from "./message-list-helpers.ts";
import { messageSelectableProps } from "./quote.tsx";
import {
	deriveEditedFiles,
	isEditedFilePart,
	isTurnEndArtifactPart,
	isTurnEndJsonRenderPart,
} from "./turn-end-cards.ts";
import type { CustomToolRendererProps } from "./types.ts";
import {
	getAssistantFileMeta,
	getAssistantVideoUrl,
} from "./utils/live-file-media.ts";
import {
	getAssistantImageMeta,
	getImageGenerationPart,
	getVideoGenerationPart,
	isErrorPart,
	isTextPart,
	nativeOptionalSdkText,
} from "./utils/live-media-observations.ts";
import {
	getFailoverNote,
	isWorkflowRunPart,
} from "./utils/live-message-flags.ts";
import {
	nativeCreatedAtLookup,
	nativeMessageDate,
} from "./utils/native-message-date-abi.ts";
import {
	isV5SdkToolPart as isV5ToolPart,
	isSdkWidgetAvailablePart as isWidgetAvailablePart,
	nativeWidgetToolCallId,
	type RenderedSdkPart,
} from "./utils/sdk-tool-observations.ts";
import { normalizeUiMessageToolParts as normalizeAssistantToolParts } from "./utils/tool-part-normalizer.ts";
import { WorkflowRunProgressCard } from "./workflow-run-part.tsx";

/**
 * Stable stand-in for "no custom renderers". `toolRenderers` is a dependency of
 * the memo that builds a message's whole element tree, so a caller passing a
 * fresh `{}` (or leaving it undefined and letting a literal default be created
 * per render) rebuilds that tree every render.
 */
const NO_TOOL_RENDERERS: Record<
	string,
	React.ComponentType<CustomToolRendererProps>
> = Object.freeze({});

export type { AssistantPartsProps } from "./assistant-parts-types.ts";

export function AssistantParts({
	msg,
	groupPosition,
	isLast,
	isStreaming,
	suppressQuestionTool,
	ToolRendererComponent,
	toolRenderers = NO_TOOL_RENDERERS,
	onOpenFile,
	onOpenLink,
	onOpenMention,
	onAnnotateImage,
	mentionItems,
	previewResolvers,
	onRetryGeneration,
	onRetryError,
	onWorkflowResume,
	onAgentUiSubmit,
	agentMessageContext,
	deferTurnEndCards,
}: AssistantPartsProps) {
	const { expandCommands, expandFileEdits, groupToolUses, hideToolDetail } =
		useChatDisplayPrefs();
	const parts = useMemo<RenderedSdkPart[]>(
		() => normalizeAssistantToolParts(msg.parts ?? []),
		[msg.parts]
	);
	const editedFiles = useMemo(() => deriveEditedFiles(parts), [parts]);
	const createdAt = nativeCreatedAtLookup(msg)?.createdAt;
	const sentAtMs = createdAt ? nativeMessageDate(createdAt).getTime() : null;
	const sentAt = useMemo(
		() =>
			sentAtMs !== null && Number.isFinite(sentAtMs)
				? new Date(sentAtMs)
				: undefined,
		[sentAtMs]
	);

	const { elements } = useMemo(() => {
		// Each part is tagged as prose or not, because only the PROSE runs get a
		// bubble (see the fold at the end of this memo). Tool rows, generated
		// media, error cards and widgets already draw their own `bg-card`
		// surfaces; boxing them a second time double-frames every one of them.
		const elems: { isText: boolean; node: React.ReactNode }[] = [];
		const pushPart = (node: React.ReactNode, isText = false) => {
			elems.push({ isText, node });
		};
		const { citations, nestedToolsMap, nestedToolIds, failoverNotes } =
			indexAssistantParts(parts, groupToolUses, hideToolDetail);
		const toolContext: AssistantToolPartContext = {
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
		};

		let i = 0;
		while (i < parts.length) {
			const part = parts[i];

			if (
				deferTurnEndCards &&
				((editedFiles.length > 0 && isEditedFilePart(part)) ||
					isTurnEndArtifactPart(part) ||
					isTurnEndJsonRenderPart(part))
			) {
				i++;
				continue;
			}

			if (isV5ToolPart(part) && part.type === "tool-TaskOutput") {
				i++;
				continue;
			}

			// The structured failover verdict, drawn as a Marker between the
			// reply's prose. `stand` never reaches a client, so any verdict that
			// arrives has something to say.
			const failoverNote = getFailoverNote(part);
			if (failoverNote) {
				pushPart(
					<Marker key={`${msg.id}-failover-${i}`} spacing="turn">
						<MarkerIcon>
							<HugeiconsIcon
								icon={ArrowDataTransferHorizontalIcon}
								strokeWidth={2}
							/>
						</MarkerIcon>
						<MarkerContent>{failoverNote}</MarkerContent>
					</Marker>
				);
				i++;
				continue;
			}

			// A workflow run part — the live per-node checklist Core streams while
			// a `workflow_id` chat turn executes. Repeated frames reconcile into
			// one part, so this renders once per turn, updating in place.
			if (isWorkflowRunPart(part)) {
				pushPart(
					<WorkflowRunProgressCard
						key={`${msg.id}-workflow-${i}`}
						msg={msg}
						onResume={onWorkflowResume}
					/>
				);
				i++;
				continue;
			}

			if (isTextPart(part)) {
				const text = part.text;
				// The plain-text twin of a verdict we just drew as a Marker. Dropped
				// here rather than server-side; see `failoverNotes` above.
				if (failoverNotes.has(text.trim())) {
					i++;
					continue;
				}
				if (text) {
					pushPart(
						// A `BubbleContent`, folded into a ghost `Bubble` with its
						// neighbouring prose parts below: plain comfortable-size prose
						// that fills the reading column.
						<BubbleContent
							className="group/assistant-text text-(length:--text-comfortable) w-full leading-(--text-comfortable--line-height)"
							corner={
								groupPosition === "single"
									? "single"
									: groupPosition === "first"
										? "start-first"
										: groupPosition === "last"
											? "start-last"
											: "start-middle"
							}
							data-chat-prose=""
							key={`${msg.id}-text-${i}`}
							surface="transcript"
							{...messageSelectableProps}
						>
							<Markdown
								citations={citations.length > 0 ? citations : undefined}
								content={text}
								isStreaming={isLast && isStreaming}
								mentionItems={mentionItems}
								onOpenFile={onOpenFile}
								onOpenLink={onOpenLink}
								onOpenMention={onOpenMention}
								previewResolvers={previewResolvers}
								wideBlocks
							/>
						</BubbleContent>,
						true
					);
				}
				i++;
				continue;
			}

			const generation = getImageGenerationPart(part);
			if (generation) {
				// Retry re-runs the SAME prompt against the same message, so it needs
				// one: a generation part that never carried a prompt (older shape, or
				// a producer that failed before it had one) gets no dead button.
				const retryPrompt = generation.prompt;
				pushPart(
					<AssistantGeneratedImage
						key={`${msg.id}-image-generation-${i}`}
						onAnnotateImage={onAnnotateImage}
						onRetry={
							onRetryGeneration && retryPrompt
								? () => onRetryGeneration(msg.id, "image", retryPrompt)
								: undefined
						}
						prompt={generation.prompt}
						showStatus
						status={generation.status}
						statusText={generation.statusText}
						url={generation.url}
					/>
				);
				i++;
				continue;
			}

			const videoGeneration = getVideoGenerationPart(part);
			if (videoGeneration) {
				const retryPrompt = videoGeneration.prompt;
				pushPart(
					<AssistantGeneratedVideo
						key={`${msg.id}-video-generation-${i}`}
						onRetry={
							onRetryGeneration && retryPrompt
								? () => onRetryGeneration(msg.id, "video", retryPrompt)
								: undefined
						}
						poster={videoGeneration.poster}
						prompt={videoGeneration.prompt}
						showStatus
						status={videoGeneration.status}
						statusText={videoGeneration.statusText}
						url={videoGeneration.url}
					/>
				);
				i++;
				continue;
			}

			const image = getAssistantImageMeta(part);
			if (image) {
				pushPart(
					<AssistantGeneratedImage
						filename={image.filename}
						key={`${msg.id}-image-${i}`}
						onAnnotateImage={onAnnotateImage}
						showStatus={false}
						status="complete"
						url={image.url}
					/>
				);
				i++;
				continue;
			}

			const videoUrl = getAssistantVideoUrl(part);
			if (videoUrl) {
				pushPart(
					<AssistantGeneratedVideo
						key={`${msg.id}-video-${i}`}
						showStatus={false}
						status="complete"
						url={videoUrl}
					/>
				);
				i++;
				continue;
			}

			const fileMeta = getAssistantFileMeta(part);
			if (fileMeta) {
				pushPart(
					fileMeta.media.startsWith("audio/") ? (
						<audio
							className="max-w-[360px]"
							controls
							key={`${msg.id}-audio-${i}`}
							src={fileMeta.url}
						>
							<a href={fileMeta.url}>Download audio</a>
						</audio>
					) : (
						<FileAttachment
							filename={fileMeta.filename}
							id={`${msg.id}-file-${i}`}
							key={`${msg.id}-file-${i}`}
							size={fileMeta.size}
							url={fileMeta.url}
						/>
					)
				);
				i++;
				continue;
			}

			if (isErrorPart(part)) {
				pushPart(
					<ErrorMessage
						key={`${msg.id}-error-${i}`}
						message={part.message}
						onRetry={onRetryError}
						title={nativeOptionalSdkText(part.title)}
					/>
				);
				i++;
				continue;
			}

			if (isV5ToolPart(part)) {
				i = pushAssistantToolPart(toolContext, part, i);
				continue;
			}

			// Route an app-widget data part (D6) through the tool renderer, keyed by
			// its shared `toolCallId` so it attaches after the matching tool row. The
			// default renderer dispatches it to the injected WidgetHostContext.
			if (isWidgetAvailablePart(part)) {
				// A widget exists only because a tool ran, so it is tool detail too.
				if (hideToolDetail) {
					i++;
					continue;
				}
				const widgetToolCallId = nativeWidgetToolCallId(part.data);
				const chatStreamingStatus =
					isLast && isStreaming ? "streaming" : undefined;
				pushPart(
					<ToolRendererComponent
						agentMessageContext={agentMessageContext}
						chatStatus={chatStreamingStatus}
						key={
							widgetToolCallId
								? `${widgetToolCallId}-widget`
								: `${msg.id}-widget-${i}`
						}
						onAgentUiSubmit={onAgentUiSubmit}
						part={part}
						toolRenderers={toolRenderers}
					/>
				);
				i++;
				continue;
			}

			i++;
		}

		// Cited sources from this turn's web tools (WebFetch/WebSearch) render as
		// a beUI citation list footer under the reply. Empty when no web tools ran.
		if (citations.length > 0) {
			const citationItems: CitationItem[] = citations.map((citation) => ({
				id: citation.url,
				title: citation.title,
				domain: hostnameOfCitation(citation.url),
				url: citation.url,
			}));
			pushPart(
				<CitationList
					citations={citationItems}
					className="mt-2"
					key={`${msg.id}-citations`}
					surface="transcript"
				/>
			);
		}

		const folded = foldAssistantProse(elems, msg.id);

		return { elements: folded };
	}, [
		parts,
		msg.id,
		isLast,
		isStreaming,
		suppressQuestionTool,
		groupToolUses,
		hideToolDetail,
		expandCommands,
		expandFileEdits,
		ToolRendererComponent,
		agentMessageContext,
		toolRenderers,
		onRetryGeneration,
		onRetryError,
		onOpenFile,
		onOpenLink,
		onOpenMention,
		onWorkflowResume,
		previewResolvers,
		mentionItems,
		deferTurnEndCards,
		editedFiles,
	]);

	// Nothing to draw for this message — return null, not an empty div. Inside
	// the turn's `flex flex-col gap-3` an empty element is not invisible: it
	// still takes a 12px gap from each neighbour. That shows up at Detail level
	// "None" (a turn of prose followed by a message of pure tool calls) and,
	// before it, for a message that held only `tool-TaskOutput` parts.
	if (elements.length === 0) {
		return null;
	}

	if (elements.length > 1) {
		return (
			<div
				className="group/assistant-turn flex flex-col gap-3"
				data-assistant-group-position={groupPosition}
			>
				{elements}
			</div>
		);
	}

	return (
		<div
			className="group/assistant-turn"
			data-assistant-group-position={groupPosition}
		>
			{elements}
		</div>
	);
}
