"use client";

import { AgentChat } from "@ryu/blocks/desktop/agent-elements/agent-chat";
import {
	InputBar,
	type InputBarProps,
} from "@ryu/blocks/desktop/agent-elements/input-bar";
import { MarkdownResponseImages } from "@ryu/blocks/desktop/agent-elements/markdown.tsx";
import type { AgentChatProps } from "@ryu/blocks/desktop/agent-elements/types";
import { Logo } from "@ryu/ui/components/logo";
import type { ReactNode } from "react";
import {
	type AssistantWidgetPlacement,
	type RyuAssistantRecentChat,
	RyuAssistantRecentChats,
	RyuAssistantWidgetFrame,
	RyuAssistantWidgetHeader,
} from "./surface.tsx";

/**
 * A complete shared assistant surface. The host supplies chat state and transport
 * callbacks; Ryu owns the transcript, composer, compact layout, recent-chat handoff,
 * and surface chrome so consumers do not rebuild the Desktop assistant by hand.
 */
export interface RyuAssistantChatProps
	extends Omit<AgentChatProps, "density" | "emptyStateFooter" | "slots"> {
	actions?: ReactNode;
	/** Disable automatic image requests from untrusted response Markdown. */
	allowResponseImages?: boolean;
	closeLabel?: string;
	closeTitle?: string;
	density?: AgentChatProps["density"];
	divider?: boolean;
	emptyStatePosition?: AgentChatProps["emptyStatePosition"];
	footer?: ReactNode;
	/** The empty start's greeting on floating surfaces. */
	greeting?: ReactNode;
	minimal?: boolean;
	onClose?: () => void;
	onSelectRecentChat?: (id: string) => void;
	placement?: AssistantWidgetPlacement;
	recentChats?: readonly RyuAssistantRecentChat[];
	showHeader?: boolean;
	slots?: AgentChatProps["slots"];
	testId?: string;
	title?: ReactNode;
}

/**
 * The floating surfaces' empty start: §9.1's start page scaled down — one 32px
 * mark and a `text-lg` greeting above the composer, recent chats below it.
 */
function RyuAssistantGreeting({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-col items-center gap-3 pb-6 text-center">
			<Logo size="32px" tone="foreground" variant="eyes" />
			<p className="font-semibold text-foreground text-lg tracking-tight">
				{children}
			</p>
		</div>
	);
}

/** Shared compact composer used by floating assistant surfaces. */
export function RyuAssistantComposer(props: InputBarProps) {
	return (
		<InputBar
			{...props}
			compact
			leftActions={null}
			onGenerateImage={undefined}
			onGenerateVideo={undefined}
			rightActions={null}
			voiceMode={undefined}
		/>
	);
}

export function RyuAssistantChat({
	actions,
	allowResponseImages = true,
	closeLabel,
	closeTitle,
	divider,
	density,
	emptyStatePosition,
	footer,
	greeting = "How can I help?",
	minimal,
	onClose,
	onSelectRecentChat,
	placement = "inline",
	recentChats,
	showHeader = true,
	slots,
	testId,
	title,
	...chatProps
}: RyuAssistantChatProps) {
	const isMinimal = minimal ?? placement === "floating";
	const recentFooter =
		recentChats && onSelectRecentChat ? (
			<RyuAssistantRecentChats
				items={recentChats}
				onSelect={onSelectRecentChat}
			/>
		) : null;
	const emptyStateFooter =
		footer || recentFooter ? (
			<>
				{footer}
				{recentFooter}
			</>
		) : undefined;
	const isEmpty = chatProps.messages.length === 0;
	const resolvedSlots = isMinimal
		? { ...slots, InputBar: slots?.InputBar ?? RyuAssistantComposer }
		: slots;

	return (
		<RyuAssistantWidgetFrame ariaLabel="Ryu assistant" placement={placement}>
			{showHeader ? (
				<RyuAssistantWidgetHeader
					actions={actions}
					closeLabel={closeLabel}
					closeTitle={closeTitle}
					divider={divider ?? placement === "docked"}
					onClose={onClose}
					testId={testId}
					title={title ?? (isMinimal ? "New chat" : "Chat")}
				/>
			) : null}
			<div className="min-h-0 flex-1">
				<MarkdownResponseImages.Provider value={allowResponseImages}>
					<AgentChat
						{...chatProps}
						// Like Desktop's floating Ask Ryu, only the composer is compact; the
						// transcript keeps its normal inset so bubbles never hug the frame.
						density={density}
						emptyStateFooter={emptyStateFooter}
						emptyStateHeader={
							isMinimal && isEmpty ? (
								<RyuAssistantGreeting>{greeting}</RyuAssistantGreeting>
							) : undefined
						}
						emptyStatePosition={
							emptyStatePosition ?? (isMinimal ? "center" : undefined)
						}
						slots={resolvedSlots}
					/>
				</MarkdownResponseImages.Provider>
			</div>
		</RyuAssistantWidgetFrame>
	);
}
