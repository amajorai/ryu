"use client";

import { Copy01Icon, MessageQuestionIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AgentChat } from "@ryu/blocks/desktop/agent-elements/agent-chat.tsx";
import type {
	ComposerMenuGroup,
	ComposerMenuItem,
} from "@ryu/blocks/desktop/agent-elements/input/composer-menu.tsx";
import type { MentionItem } from "@ryu/blocks/desktop/agent-elements/types.ts";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import type { UIMessage } from "ai";
import { useCallback, useMemo } from "react";
import { sileo } from "sileo";

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
	/** Main-chat directory data, projected into the same `+` / `@` primitives. */
	composerMenuGroups?: ComposerMenuGroup[];
	mentionItems?: MentionItem[];
	/** Ask another ephemeral side question from the shared composer. */
	onAsk?: (question: string) => void;
	/** Dismiss the overlay (the answer is discarded — never enters history). */
	onClose: () => void;
	onComposerMenuSelect?: (item: ComposerMenuItem) => void;
	/** Stop the client request while keeping the question available for retry. */
	onStop: () => void;
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
export function BtwOverlay({
	state,
	onClose,
	onAsk,
	onStop,
	composerMenuGroups,
	mentionItems,
	onComposerMenuSelect,
}: BtwOverlayProps) {
	const tl = useLiteralMessages();
	const open = state !== null;
	const messages = useMemo<UIMessage[]>(() => {
		if (!state?.question) {
			return [];
		}
		const next: UIMessage[] = [
			{
				id: "btw-question",
				parts: [{ text: state.question, type: "text" }],
				role: "user",
			},
		];
		if (state.answer) {
			next.push({
				id: "btw-answer",
				parts: [{ text: state.answer, type: "text" }],
				role: "assistant",
			});
		}
		return next;
	}, [state]);
	const handleSend = useCallback(
		(message: { role: "user"; content: string }) => onAsk?.(message.content),
		[onAsk]
	);

	const copyAnswer = () => {
		if (!state?.answer) {
			return;
		}
		navigator.clipboard
			.writeText(state.answer)
			.then(() => sileo.success({ title: "Answer copied" }))
			.catch(() => sileo.error({ title: "Could not copy answer" }));
	};

	return (
		<Dialog onOpenChange={(o) => (o ? undefined : onClose())} open={open}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle layout="inline">
						<HugeiconsIcon
							className="size-4 text-muted-foreground"
							icon={MessageQuestionIcon}
						/>
						Side question
					</DialogTitle>
					<DialogDescription className="text-left">
						The answer stays out of the main transcript and this side chat has
						no tools.
					</DialogDescription>
				</DialogHeader>

				<div className="h-[min(55vh,34rem)] min-h-[12rem]">
					<AgentChat
						composerDisabled={!onAsk}
						composerMenuGroups={composerMenuGroups}
						density="compact"
						error={state?.error ? new Error(state.error) : undefined}
						mentionItems={mentionItems}
						messages={messages}
						onComposerMenuSelect={onComposerMenuSelect}
						onSend={handleSend}
						onStop={onStop}
						status={state?.loading ? "streaming" : "ready"}
					/>
				</div>

				<DialogFooter className="items-center justify-between sm:justify-between">
					<span className="text-muted-foreground text-xs">
						{state?.model
							? tl("{model} · outside main transcript", { model: state.model })
							: "Outside main transcript"}
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
