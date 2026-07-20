"use client";

import { Copy01Icon, MessageQuestionIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { TextShimmer } from "@ryu/blocks/desktop/agent-elements/text-shimmer";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { sileo } from "sileo";
import { Markdown } from "@/components/agent-elements/markdown.tsx";

/** Ephemeral state of a `/btw` side question shown in the overlay. */
export interface BtwState {
	/** The answer once it arrives (Markdown), or null while loading/errored. */
	answer: string | null;
	/** An error message when the side question failed. */
	error: string | null;
	/** True while the answer is being fetched. */
	loading: boolean;
	/** The model that answered (resolved server-side). */
	model: string | null;
	/** The side question the user asked. */
	question: string;
}

export interface BtwOverlayProps {
	/** Dismiss the overlay (the answer is discarded — never enters history). */
	onClose: () => void;
	/** The current side question, or null when the overlay is closed. */
	state: BtwState | null;
}

/**
 * Dismissible overlay for a `/btw` side question (modeled on Claude Code's
 * interactive `/btw`). The question and answer are ephemeral: they appear here
 * and are discarded on close, never entering the conversation history. The side
 * model sees the conversation context but has no tools, so this is a quick aside
 * that doesn't derail the main chat.
 */
export function BtwOverlay({ state, onClose }: BtwOverlayProps) {
	const open = state !== null;

	const copyAnswer = () => {
		if (!state?.answer) {
			return;
		}
		navigator.clipboard
			.writeText(state.answer)
			.then(() => sileo.success("Answer copied"))
			.catch(() => sileo.error("Could not copy answer"));
	};

	return (
		<Dialog onOpenChange={(o) => (o ? undefined : onClose())} open={open}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<HugeiconsIcon
							className="size-4 text-muted-foreground"
							icon={MessageQuestionIcon}
						/>
						Side question
					</DialogTitle>
					<DialogDescription className="text-left">
						{state?.question}
					</DialogDescription>
				</DialogHeader>

				<div className="max-h-[50vh] overflow-y-auto">
					{state?.loading && (
						<TextShimmer className="text-muted-foreground text-sm">
							Thinking…
						</TextShimmer>
					)}
					{state?.error && (
						<p className="text-destructive text-sm">{state.error}</p>
					)}
					{state?.answer && (
						<Markdown className="text-sm" content={state.answer} />
					)}
				</div>

				<DialogFooter className="items-center justify-between gap-2 sm:justify-between">
					<span className="text-muted-foreground text-xs">
						{state?.model
							? `${state.model} · not saved to history`
							: "Not saved to history"}
					</span>
					<div className="flex items-center gap-2">
						{state?.answer && (
							<Button
								onClick={copyAnswer}
								size="sm"
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="size-3.5" icon={Copy01Icon} />
								Copy
							</Button>
						)}
						<Button onClick={onClose} size="sm" type="button">
							Dismiss
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
