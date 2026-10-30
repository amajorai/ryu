"use client";

import type { Transition } from "motion/react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { ComposerToolbar } from "./input/composer-toolbar.tsx";
import type { useDraftSave } from "./input/use-draft-save.ts";
import type { InputBarProps } from "./input-bar-types.ts";

/** Whether any host prop asks for the composer controls row. */
export function shouldRenderInputBarToolbar(
	{
		liveCall,
		compact,
		draftControls,
		leftActions,
		rightActions,
		voice,
		voiceMode,
		onGenerateImage,
		onGenerateVideo,
		onSketch,
		goalControls,
		ghostControls,
		pluginControls,
		composerMenuGroups,
		contextMeter,
		expandComposer,
	}: InputBarProps,
	showAttach: boolean
): boolean {
	return Boolean(
		liveCall ||
			compact ||
			draftControls ||
			leftActions ||
			rightActions ||
			showAttach ||
			voice ||
			voiceMode ||
			onGenerateImage ||
			onGenerateVideo ||
			onSketch ||
			goalControls ||
			ghostControls ||
			pluginControls?.length ||
			composerMenuGroups?.some((group) => group.items.length > 0) ||
			contextMeter ||
			expandComposer
	);
}

type InputBarToolbarHostProps = Pick<
	InputBarProps,
	| "composerMenuGroups"
	| "contextMeter"
	| "contextMeterOnOpen"
	| "disabled"
	| "doubleCheckControls"
	| "draftControls"
	| "expandComposer"
	| "ghostControls"
	| "goalControls"
	| "leftActions"
	| "liveCall"
	| "onAttach"
	| "onComposerMenuSelect"
	| "onGenerateImage"
	| "onGenerateVideo"
	| "onSketch"
	| "onStop"
	| "pluginControls"
	| "rightActions"
	| "voice"
	| "voiceMode"
>;

export interface InputBarToolbarProps extends InputBarToolbarHostProps {
	composerEditor: ReactNode;
	composerTransition: Transition;
	draftSave: ReturnType<typeof useDraftSave>;
	focusComposer: () => void;
	handleGenerateImage: () => void;
	handleGenerateVideo: () => void;
	handleSubmit: (followUpMode?: "opposite") => void;
	hasInput: boolean;
	input: string;
	isCompactSingleRow: boolean;
	isExpanded: boolean;
	isGenerating: boolean;
	isGeneratingVideo: boolean;
	isRecording: boolean;
	isStreaming: boolean;
	isTranscribing: boolean;
	openExpandedComposer: () => void;
	plusMenuQueryStart: number | null;
	reduceMotion: boolean;
	setInput: (v: string) => void;
	setPlusMenuQueryStart: Dispatch<SetStateAction<number | null>>;
	showAttach: boolean;
	startVoice: () => void;
	stopVoice: () => void;
}

/** The composer controls row wrapped around the editor slot. */
export function InputBarToolbar({
	composerEditor,
	composerMenuGroups,
	composerTransition,
	contextMeter,
	contextMeterOnOpen,
	disabled,
	doubleCheckControls,
	draftControls,
	draftSave,
	expandComposer,
	focusComposer,
	ghostControls,
	goalControls,
	handleGenerateImage,
	handleGenerateVideo,
	handleSubmit,
	hasInput,
	input,
	isCompactSingleRow,
	isExpanded,
	isGenerating,
	isGeneratingVideo,
	isRecording,
	isStreaming,
	isTranscribing,
	leftActions,
	liveCall,
	onAttach,
	onComposerMenuSelect,
	onGenerateImage,
	onGenerateVideo,
	onSketch,
	onStop,
	openExpandedComposer,
	pluginControls,
	plusMenuQueryStart,
	reduceMotion,
	rightActions,
	setInput,
	setPlusMenuQueryStart,
	showAttach,
	startVoice,
	stopVoice,
	voice,
	voiceMode,
}: InputBarToolbarProps) {
	return (
		<ComposerToolbar
			center={composerEditor}
			compact={isCompactSingleRow}
			contextMeter={contextMeter}
			contextMeterOnOpen={contextMeterOnOpen}
			directoryGroups={composerMenuGroups}
			directoryQuery={
				plusMenuQueryStart === null ? "" : input.slice(plusMenuQueryStart)
			}
			disabled={disabled}
			doubleCheckControls={doubleCheckControls}
			// Both draft actions live in the "+" menu: "Save draft" and the
			// project's saved drafts, so the toolbar keeps to +, picker, mic, send.
			drafts={
				draftControls
					? {
							canSave: !(disabled || draftSave.saving) && Boolean(input.trim()),
							items: draftControls.items,
							onDelete: draftControls.onDelete,
							onInsert: (text) => {
								(draftControls.onInsert ?? setInput)(text);
								focusComposer();
							},
							onSave: () => void draftSave.save(),
							saving: draftSave.saving,
						}
					: undefined
			}
			ghostControls={ghostControls}
			goalControls={goalControls}
			hasImageGen={Boolean(onGenerateImage)}
			hasInput={hasInput}
			hasVideoGen={Boolean(onGenerateVideo)}
			hasVoice={Boolean(voice)}
			isGeneratingImage={isGenerating}
			isGeneratingVideo={isGeneratingVideo}
			isRecording={isRecording}
			isStreaming={isStreaming}
			isTranscribing={isTranscribing}
			leftActions={leftActions}
			liveCallActions={liveCall?.actions}
			motionEnabled={!reduceMotion}
			onAttach={onAttach}
			onDirectorySelect={(item) => {
				const start = plusMenuQueryStart ?? input.length;
				const prefix = input.slice(0, start).trimEnd();
				setInput(`${prefix}${prefix ? " " : ""}@${item.label} `);
				setPlusMenuQueryStart(null);
				onComposerMenuSelect?.(item);
			}}
			onExpand={
				expandComposer && !isExpanded ? openExpandedComposer : undefined
			}
			onGenerateImage={handleGenerateImage}
			onGenerateVideo={handleGenerateVideo}
			onMenuOpenChange={(open) => {
				setPlusMenuQueryStart(open ? input.length : null);
				if (open) {
					requestAnimationFrame(focusComposer);
				}
			}}
			onSketch={onSketch}
			onStartVoice={startVoice}
			onStop={onStop}
			onStopVoice={stopVoice}
			onSubmit={handleSubmit}
			pluginControls={pluginControls}
			rightActions={rightActions}
			showAttach={showAttach}
			transition={composerTransition}
			voiceDisabled={voice?.disabled}
			voiceMode={voiceMode}
		/>
	);
}
