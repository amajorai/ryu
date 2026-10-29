"use client";

// The island's transcript IS the desktop transcript.
//
// Everything the desktop chat renders — tool rows, MCP widgets, image
// generation, reasoning, citations, file parts, error cards — comes from
// `@ryu/blocks/desktop/agent-elements/message-list`. The island used to ship a
// hand-rolled plain-text list, so every part type the desktop gained (a new tool
// renderer, a widget) silently rendered as nothing here. This file is the seam
// that stops that drift: one component, two densities.
//
// What the island supplies is the *density*, not a second implementation:
// `density: "compact"` drops the reading aids that need width (the floating TOC,
// the pinned user-message bar, the centred 720px column) and tightens padding.
// A new desktop part type shows up here for free.
//
// The Global Island keeps its blended glass treatment by configuring the shared
// InputBar as compact and seamless; it does not fork the chat input behavior.

import type { ChatStatus, UIMessage } from "ai";
import type { ComponentProps } from "react";
import type { ChatDisplayPrefs } from "../../desktop/agent-elements/chat-display-prefs.tsx";
import { ChatDisplayPrefsProvider } from "../../desktop/agent-elements/chat-display-prefs.tsx";
import { MessageList } from "../../desktop/agent-elements/message-list.tsx";

type MessageListProps = ComponentProps<typeof MessageList>;

export interface IslandTranscriptProps {
	/** Assistant avatar. Off by default — the island bar is ~380px wide. */
	assistantAvatar?: MessageListProps["assistantAvatar"];
	assistantName?: MessageListProps["assistantName"];
	className?: string;
	messages: UIMessage[];
	/** Fork this turn into a new chat. Omitted ⇒ no branch button. */
	onBranch?: MessageListProps["onBranch"];
	onOpenFile?: MessageListProps["onOpenFile"];
	onRegenerateMessage?: MessageListProps["onRegenerateMessage"];
	/** Speak an assistant turn aloud. The island wires this to Core's TTS. */
	onSpeak?: MessageListProps["onSpeak"];
	/** Same slot contract as the desktop chat (custom InputBar/UserMessage). */
	slots?: MessageListProps["slots"];
	status: ChatStatus;
	/** Per-tool overrides, same registry the desktop passes. */
	toolRenderers?: MessageListProps["toolRenderers"];
}

/**
 * Module-level so the context value has a stable identity — an inline literal
 * re-renders every transcript consumer on every island render, since a context
 * read is not gated by `memo()`.
 */
const ISLAND_DISPLAY_PREFS: Partial<ChatDisplayPrefs> = {
	density: "compact",
	// Long bash output and file diffs would swallow the whole island; they stay
	// collapsed behind their disclosure here regardless of the desktop's own
	// setting.
	expandCommands: false,
	expandFileEdits: false,
	pinUserMessage: false,
	// NOT inherited: Detail level "None" (`hideToolDetail`). Deliberate, and it
	// has to be — the island is a separate Electron process that cannot read the
	// desktop's localStorage, where `ryu:hide-tool-detail` lives. The only pref
	// that does cross is `island-appearance`, and that is a window-material
	// contract (changing it recreates the window), not a transcript channel.
	//
	// Leaving it at the provider default (`false`, i.e. tool rows shown) is also
	// the right *product* answer, not just the cheap one: this surface already
	// pins its own detail prefs above, and the island is where the user watches a
	// background agent work. A pure messaging view there would show a turn
	// running with nothing on screen at all.
	//
	// Making it follow the desktop is a cross-process feature, not a line here:
	// the desktop would have to mirror the pref into Core's KV store, plus a new
	// IPC channel + preload + renderer hook. That belongs in its own task.
};

export function IslandTranscript({
	assistantAvatar,
	assistantName,
	className,
	messages,
	onBranch,
	onOpenFile,
	onRegenerateMessage,
	onSpeak,
	slots,
	status,
	toolRenderers,
}: IslandTranscriptProps) {
	return (
		<ChatDisplayPrefsProvider value={ISLAND_DISPLAY_PREFS}>
			<MessageList
				assistantAvatar={assistantAvatar}
				assistantName={assistantName}
				className={className}
				messages={messages}
				onBranch={onBranch}
				onOpenFile={onOpenFile}
				onRegenerateMessage={onRegenerateMessage}
				onSpeak={onSpeak}
				showCopyToolbar
				slots={slots}
				status={status}
				toolRenderers={toolRenderers}
			/>
		</ChatDisplayPrefsProvider>
	);
}
