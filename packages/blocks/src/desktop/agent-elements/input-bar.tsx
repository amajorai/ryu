"use client";

import { useMediaQuery } from "@ryu/ui/hooks/use-mobile.ts";
import { SPRING_MORPH } from "@ryu/ui/lib/ease";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useChatDisplayPrefs } from "./chat-display-prefs.tsx";
import { hasComposerInput } from "./input/composer-input.ts";
import { useInputTyping } from "./input/input-typing.tsx";
import { Suggestions } from "./input/suggestions.tsx";
import { useDraftSave } from "./input/use-draft-save.ts";
import { useComposerClipboard } from "./input-bar-clipboard.ts";
import { useComposerPreview } from "./input-bar-composer-preview.tsx";
import {
	DEFAULT_INPUT_CONFIG,
	NO_ATTACHED_FILES,
	NO_ATTACHED_IMAGES,
} from "./input-bar-defaults.ts";
import { InputBarFrame } from "./input-bar-frame.tsx";
import { useComposerInfoBar } from "./input-bar-info-bar.tsx";
import {
	ComposerEditorSlot,
	ComposerInputContent,
	resolveComposerSuggestions,
} from "./input-bar-input-content.tsx";
import {
	useComposerContainerClick,
	useComposerExpansion,
	useComposerSuggestionSelect,
} from "./input-bar-interactions.ts";
import { useComposerKeyDown, useComposerSubmit } from "./input-bar-keyboard.ts";
import { useComposerMediaGeneration } from "./input-bar-media-generation.ts";
import { useComposerAttachmentMentions } from "./input-bar-mentions.tsx";
import { useComposerQuestionBar } from "./input-bar-question-bar.tsx";
import { ComposerSurface } from "./input-bar-surface.tsx";
import {
	useComposerHeightReport,
	useComposerTextareaAutoResize,
} from "./input-bar-textarea-size.ts";
import {
	InputBarToolbar,
	shouldRenderInputBarToolbar,
} from "./input-bar-toolbar.tsx";
import {
	deriveTurnProgressSummary,
	InputBarTurnProgressStrip,
} from "./input-bar-turn-progress.tsx";
import type { InputBarProps } from "./input-bar-types.ts";
import { useComposerVoiceInput } from "./input-bar-voice.ts";

export type {
	AttachedFile,
	AttachedImage,
	ComposerDraftControls,
	ComposerDraftItem,
	ComposerLiveCall,
	InputBarInfoBar,
	InputBarProps,
	InputBarTurnProgress,
	TemporaryChatSaveControls,
} from "./input-bar-types.ts";

export const InputBar = memo(function InputBar(props: InputBarProps) {
	const {
		onSend,
		status,
		placeholder,
		textareaAriaLabel,
		placeholderSuggestion,
		prediction,
		className,
		onAttach,
		onAnnotateImage,
		attachedImages = NO_ATTACHED_IMAGES,
		attachedFiles = NO_ATTACHED_FILES,
		changeSummary,
		turnProgress,
		onRemoveImage,
		onRemoveFile,
		onPaste,
		isDragOver,
		enableImagePreview = true,
		value: controlledValue,
		onChange: controlledOnChange,
		disabled,
		composerPrompt,
		expandComposer,
		compact,
		ghost,
		autoFocus,
		suggestions = [],
		typingAnimation,
		infoBar,
		questionBar,
		queueBar,
		enableQueue,
		liveCall,
		draftControls,
		seamless,
		voice,
		onGenerateImage,
		onGenerateVideo,
		goalBar,
		workspaceBar,
		composerHeader,
		mentionItems: hostMentionItems,
		onHeightChange,
		onTextareaKeyDown,
		temporaryChatSaveControls,
	} = props;
	const [internalInput, setInternalInput] = useState("");
	const [suggestionIndex, setSuggestionIndex] = useState(-1);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const richEditorRef = useRef<HTMLDivElement>(null);
	const { animationsEnabled, composerSendShortcut, markdownComposer } =
		useChatDisplayPrefs();
	const isControlled = controlledValue !== undefined;
	const input = isControlled ? controlledValue : internalInput;
	const setInput = useCallback(
		(v: string) => {
			if (isControlled) {
				controlledOnChange?.(v);
			} else {
				setInternalInput(v);
			}
		},
		[isControlled, controlledOnChange]
	);
	const mentionItems = useComposerAttachmentMentions({
		attachedFiles,
		attachedImages,
		hostMentionItems,
		input,
		setInput,
	});
	const draftSave = useDraftSave(input, setInput, draftControls?.onSave);
	const { handleComposerCopy, handleComposerPaste } = useComposerClipboard({
		input,
		markdownComposer,
		mentionItems,
		onPaste,
		setInput,
		textareaRef,
	});
	const containerRef = useRef<HTMLDivElement>(null);
	const [isCompactTextareaMultiline, setIsCompactTextareaMultiline] =
		useState(false);
	const [plusMenuQueryStart, setPlusMenuQueryStart] = useState<number | null>(
		null
	);
	const config = DEFAULT_INPUT_CONFIG;
	const focusComposer = useCallback(() => {
		if (markdownComposer) {
			richEditorRef.current?.focus();
			return;
		}
		textareaRef.current?.focus();
	}, [markdownComposer]);
	const { isExpanded, openExpandedComposer, setIsExpanded } =
		useComposerExpansion({ expandComposer, focusComposer });
	const isCompactSingleRow = Boolean(
		compact && !isCompactTextareaMultiline && !isExpanded && !markdownComposer
	);
	const prefersReducedMotion = useMediaQuery(
		"(prefers-reduced-motion: reduce)"
	);
	const reduceMotion = !animationsEnabled || prefersReducedMotion;
	const composerTransition = reduceMotion ? { duration: 0 } : SPRING_MORPH;

	useComposerHeightReport(containerRef, onHeightChange);

	const {
		state: voiceState,
		levels: voiceLevels,
		error: voiceError,
		clearError: clearVoiceError,
		start: startVoice,
		stop: stopVoice,
	} = useComposerVoiceInput({ focusComposer, input, setInput, voice });
	const isRecording = voiceState === "recording";
	const isTranscribing = voiceState === "transcribing";

	const { effectiveInfoBar, handleInfoBarClose, isInfoBarOpen } =
		useComposerInfoBar(infoBar, voiceError, clearVoiceError);

	const {
		handleGenerateImage,
		handleGenerateVideo,
		isGenerating,
		isGeneratingVideo,
	} = useComposerMediaGeneration({
		input,
		onGenerateImage,
		onGenerateVideo,
		setInput,
	});

	const isStreaming = status === "streaming" || status === "submitted";
	const isTyping = typingAnimation?.isActive ?? false;

	const { displayedText, showImage } = useInputTyping(
		typingAnimation?.text ?? "",
		typingAnimation?.duration ?? 2000,
		isTyping,
		typingAnimation?.onComplete ?? (() => {})
	);

	const canQueueNow = Boolean(enableQueue) && isStreaming;
	const effectivePlaceholder =
		canQueueNow && !isTyping
			? "Send a message…"
			: (placeholder ?? config.inputBarPlaceholder);

	const showAttach = Boolean(onAttach);

	useComposerTextareaAutoResize({
		compact,
		containerRef,
		input,
		isCompactSingleRow,
		isExpanded,
		markdownComposer,
		setIsCompactTextareaMultiline,
		textareaRef,
	});

	useEffect(() => {
		if (!autoFocus) {
			return;
		}
		focusComposer();
	}, [autoFocus, focusComposer]);

	const hasContextItems = attachedImages.length > 0 || attachedFiles.length > 0;
	const hasInput = hasComposerInput(
		input,
		attachedImages.length + attachedFiles.length
	);

	const handleSubmit = useComposerSubmit({
		disabled,
		enableQueue,
		hasInput,
		input,
		isStreaming,
		onSend,
		queueBar,
		setInput,
	});

	const infoBarPosition = effectiveInfoBar?.position ?? "top";
	const shouldShowInfoBar = Boolean(
		effectiveInfoBar && (effectiveInfoBar.title || effectiveInfoBar.description)
	);

	const { questionBarData, questionBarNode } = useComposerQuestionBar(
		questionBar,
		voice
	);

	const activeComposerPrompt = composerPrompt
		? composerPrompt
		: questionBarNode
			? {
					id: `question:${questionBarData?.id ?? "pending"}`,
					content: questionBarNode,
				}
			: undefined;

	const handleKeyDown = useComposerKeyDown({
		composerSendShortcut,
		handleSubmit,
		input,
		isExpanded,
		isStreaming,
		markdownComposer,
		onTextareaKeyDown,
		placeholderSuggestion,
		prediction,
		richEditorRef,
		setInput,
		setIsExpanded,
		setSuggestionIndex,
		suggestionIndex,
		suggestions,
	});

	const {
		suggestionButtonClassName,
		suggestionItems,
		suggestionsContainerClassName,
	} = resolveComposerSuggestions(suggestions);
	const composerSuggestions = suggestionItems;
	const showComposerSuggestions =
		composerSuggestions.length > 0 && !hasInput && !isStreaming;
	const ghostSuggestion = prediction || placeholderSuggestion;
	// A prediction stands on its own; a placeholder prompt only previews a list.
	const showPlaceholderSuggestion =
		!(hasInput || isStreaming) &&
		suggestionIndex < 0 &&
		(Boolean(prediction) ||
			(showComposerSuggestions && Boolean(placeholderSuggestion)));
	const showContextItems =
		hasContextItems && config.attachmentPreviewStyle !== "hidden";
	const safeTypingAnimationImage = safeMediaUrl(typingAnimation?.image);
	const imageDisplayMode =
		config.attachmentPreviewStyle === "thumbnail" ? "image-only" : "chip";
	const { effectiveChangeSummary, showChangeSummary, showTurnProgress } =
		deriveTurnProgressSummary(turnProgress, changeSummary);

	const handleContainerClick = useComposerContainerClick(focusComposer);

	const handleSuggestionSelect = useComposerSuggestionSelect({
		disabled,
		focusComposer,
		isStreaming,
		markdownComposer,
		setInput,
		textareaRef,
	});
	const { composerPreviewRef, renderComposerPreview, tokenDrag } =
		useComposerPreview({
			disabled,
			input,
			mentionItems,
			reduceMotion,
			setInput,
			textareaRef,
		});

	const inputContent = (
		<ComposerInputContent
			composerPreviewRef={composerPreviewRef}
			composerSuggestions={composerSuggestions}
			disabled={disabled}
			displayedText={displayedText}
			effectivePlaceholder={effectivePlaceholder}
			ghostSuggestion={ghostSuggestion}
			handleComposerCopy={handleComposerCopy}
			handleComposerPaste={handleComposerPaste}
			handleKeyDown={handleKeyDown}
			handleSuggestionSelect={handleSuggestionSelect}
			input={input}
			isCompactSingleRow={isCompactSingleRow}
			isRecording={isRecording}
			isTyping={isTyping}
			markdownComposer={markdownComposer}
			mentionItems={mentionItems}
			prediction={prediction}
			renderComposerPreview={renderComposerPreview}
			richEditorRef={richEditorRef}
			setInput={setInput}
			setSuggestionIndex={setSuggestionIndex}
			showComposerSuggestions={showComposerSuggestions}
			showPlaceholderSuggestion={showPlaceholderSuggestion}
			suggestionIndex={suggestionIndex}
			textareaAriaLabel={textareaAriaLabel}
			textareaRef={textareaRef}
			tokenDrag={tokenDrag}
			voiceLevels={voiceLevels}
		/>
	);

	const composerEditor = (
		<ComposerEditorSlot
			inputContent={inputContent}
			isCompactSingleRow={isCompactSingleRow}
			isExpanded={isExpanded}
			liveCall={liveCall}
		/>
	);
	const shouldRenderToolbar = shouldRenderInputBarToolbar(props, showAttach);
	const composerToolbar = (
		<InputBarToolbar
			{...props}
			composerEditor={composerEditor}
			composerTransition={composerTransition}
			draftSave={draftSave}
			focusComposer={focusComposer}
			handleGenerateImage={handleGenerateImage}
			handleGenerateVideo={handleGenerateVideo}
			handleSubmit={handleSubmit}
			hasInput={hasInput}
			input={input}
			isCompactSingleRow={isCompactSingleRow}
			isExpanded={isExpanded}
			isGenerating={isGenerating}
			isGeneratingVideo={isGeneratingVideo}
			isRecording={isRecording}
			isStreaming={isStreaming}
			isTranscribing={isTranscribing}
			openExpandedComposer={openExpandedComposer}
			plusMenuQueryStart={plusMenuQueryStart}
			reduceMotion={reduceMotion}
			setInput={setInput}
			setPlusMenuQueryStart={setPlusMenuQueryStart}
			showAttach={showAttach}
			startVoice={startVoice}
			stopVoice={stopVoice}
		/>
	);

	const renderComposerSuggestions = (expanded: boolean) =>
		suggestionItems.length > 0 && !activeComposerPrompt && !liveCall ? (
			<Suggestions
				containerClassName={cn(
					expanded ? "mt-2 px-1" : "mt-4 px-3",
					suggestionsContainerClassName
				)}
				disabled={disabled || isStreaming}
				itemClassName={suggestionButtonClassName}
				items={suggestionItems}
				onSelect={handleSuggestionSelect}
			/>
		) : null;

	const renderComposerSurface = (expanded: boolean) => (
		<ComposerSurface
			activeComposerPrompt={activeComposerPrompt}
			attachedFiles={attachedFiles}
			attachedImages={attachedImages}
			composerEditor={composerEditor}
			composerHeader={composerHeader}
			composerToolbar={composerToolbar}
			composerTransition={composerTransition}
			draftSaveError={draftSave.error}
			enableImagePreview={enableImagePreview}
			expanded={expanded}
			ghost={ghost}
			handleContainerClick={handleContainerClick}
			imageDisplayMode={imageDisplayMode}
			isDragOver={isDragOver}
			isTyping={isTyping}
			liveCall={liveCall}
			onAnnotateImage={onAnnotateImage}
			onRemoveFile={onRemoveFile}
			onRemoveImage={onRemoveImage}
			reduceMotion={reduceMotion}
			safeTypingAnimationImage={safeTypingAnimationImage}
			seamless={seamless}
			setIsExpanded={setIsExpanded}
			shouldRenderToolbar={shouldRenderToolbar}
			showContextItems={showContextItems}
			showImage={showImage}
		/>
	);

	return (
		<InputBarFrame
			className={className}
			composerTransition={composerTransition}
			containerRef={containerRef}
			effectiveInfoBar={effectiveInfoBar}
			ghost={ghost}
			goalBar={goalBar}
			handleInfoBarClose={handleInfoBarClose}
			infoBarPosition={infoBarPosition}
			isExpanded={isExpanded}
			isInfoBarOpen={isInfoBarOpen}
			liveCall={liveCall}
			queueBar={queueBar}
			renderComposerSuggestions={renderComposerSuggestions}
			renderComposerSurface={renderComposerSurface}
			seamless={seamless}
			shouldShowInfoBar={shouldShowInfoBar}
			temporaryChatSaveControls={temporaryChatSaveControls}
			turnProgressStrip={
				showTurnProgress ? (
					<InputBarTurnProgressStrip
						effectiveChangeSummary={effectiveChangeSummary}
						reduceMotion={reduceMotion}
						showChangeSummary={showChangeSummary}
						turnProgress={turnProgress}
					/>
				) : null
			}
			workspaceBar={workspaceBar}
		/>
	);
});
