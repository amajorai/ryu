"use client";

import { cn } from "@ryu/ui/lib/utils";
import { motion, type Transition } from "motion/react";
import type { ReactNode, RefObject } from "react";
import { GoalBar } from "./input/goal-bar.tsx";
import { InputBarInfoStrip, TemporaryChatBar } from "./input-bar-info-bar.tsx";
import type { InputBarInfoBar, InputBarProps } from "./input-bar-types.ts";
import { QueueBar } from "./queue/queue-bar.tsx";

export interface InputBarFrameProps {
	className?: string;
	composerTransition: Transition;
	containerRef: RefObject<HTMLDivElement | null>;
	effectiveInfoBar: InputBarInfoBar | undefined;
	ghost?: boolean;
	goalBar: InputBarProps["goalBar"];
	handleInfoBarClose: () => void;
	infoBarPosition: "top" | "bottom";
	isExpanded: boolean;
	isInfoBarOpen: boolean;
	liveCall: InputBarProps["liveCall"];
	queueBar: InputBarProps["queueBar"];
	renderComposerSuggestions: (expanded: boolean) => ReactNode;
	renderComposerSurface: (expanded: boolean) => ReactNode;
	seamless?: boolean;
	shouldShowInfoBar: boolean;
	temporaryChatSaveControls: InputBarProps["temporaryChatSaveControls"];
	turnProgressStrip: ReactNode;
	workspaceBar?: ReactNode;
}

/**
 * The outer composer frame: turn progress, goal / temporary / info / queue
 * bars stacked around the composer card, and the workspace action bar.
 */
export function InputBarFrame({
	className,
	composerTransition,
	containerRef,
	effectiveInfoBar,
	ghost,
	goalBar,
	handleInfoBarClose,
	infoBarPosition,
	isExpanded,
	isInfoBarOpen,
	liveCall,
	queueBar,
	renderComposerSuggestions,
	renderComposerSurface,
	seamless,
	shouldShowInfoBar,
	temporaryChatSaveControls,
	turnProgressStrip,
	workspaceBar,
}: InputBarFrameProps) {
	const hasComposerFrameBars =
		!seamless && (shouldShowInfoBar || goalBar || workspaceBar || ghost);
	const infoBarNode = shouldShowInfoBar ? (
		<InputBarInfoStrip
			effectiveInfoBar={effectiveInfoBar}
			handleInfoBarClose={handleInfoBarClose}
			isInfoBarOpen={isInfoBarOpen}
		/>
	) : null;
	// Action bar: the workspace strip (project ▸ branch ▸ worktree) rendered as a
	// full-width footer directly beneath the textarea, part of the outer card — a thin
	// muted row with rounded bottom corners, exactly like the info bar's bottom variant.
	//
	// It carries its OWN fill. The comment above has always described a "muted row",
	// but the element had neither, so it inherited the composer card's background
	// and read as part of the textarea rather than as a strip under it — most
	// obviously in compact mode, where the textarea block is short enough that the
	// two became one undifferentiated box.
	const actionBarNode = workspaceBar ? (
		<div
			className={cn(
				"flex h-[34px] min-w-0 items-center gap-0.5 px-2",
				seamless ? "bg-transparent" : "rounded-b-2xl"
			)}
		>
			{workspaceBar}
		</div>
	) : null;
	const ghostBarNode = ghost ? (
		<TemporaryChatBar temporaryChatSaveControls={temporaryChatSaveControls} />
	) : null;
	// Queue bar sits between a top info bar and the question bar. It only rounds
	// its top corners when nothing (info bar) is stacked above it.
	const noTopInfoBar = !shouldShowInfoBar || infoBarPosition === "bottom";
	// Narrow on `queueBar` itself rather than re-reading it optionally per prop:
	// the old form forwarded six `queueBar?.x` values, every one of them
	// `T | undefined`, into props QueueBarProps declares as required. Spreading
	// the narrowed object also keeps the two in step as QueueBarProps grows.
	const queueBarNode =
		queueBar && queueBar.items.length > 0 ? (
			<QueueBar {...queueBar} roundTop={noTopInfoBar} />
		) : null;
	return (
		<div className={cn("shrink-0 px-3 pb-3", className)} ref={containerRef}>
			<motion.div
				className={cn(
					"mx-auto w-full",
					// Expanded composition keeps the existing extra 100px of room.
					isExpanded
						? "max-w-[calc(var(--an-max-width,880px)_+_100px)]"
						: "max-w-[var(--an-max-width,880px)]"
				)}
				transition={composerTransition}
			>
				{turnProgressStrip}
				<div
					className={cn(
						"flex flex-col gap-0",
						// Reference architecture: the outer wrapper is the FRAME color
						// (distinct from the input box), so the bars — which carry no bg of
						// their own — show this color, and the sliver at the input box's
						// rounded corners is the same color as the bars (seamless).
						hasComposerFrameBars ? "rounded-2xl bg-muted/40" : null
					)}
				>
					{goalBar && <GoalBar {...goalBar} />}
					{ghostBarNode}
					{infoBarPosition === "top" && infoBarNode}
					{queueBarNode}
					{liveCall?.frame
						? liveCall.frame(renderComposerSurface(isExpanded))
						: renderComposerSurface(isExpanded)}
					{renderComposerSuggestions(isExpanded)}
					{infoBarPosition === "bottom" && infoBarNode}
					{/* Action bar (project ▸ branch ▸ worktree): full-width footer inside
					    the card, directly beneath the input — same slot as the bottom
					    info bar. */}
					{actionBarNode}
				</div>
			</motion.div>
		</div>
	);
}
