// Shared types for the @ryu/command palette + chat surfaces.
//
// This package is renderer-only and TRANSPORT-AGNOSTIC: it never imports fetch,
// SSE, AI-SDK, or electron. The chat surface takes an injected `ChatStreamFn`
// supplied by each consumer (desktop → AI SDK transport; the command bar →
// `window.command.core.chatStream` IPC; raycast → its own fetch). That injection
// boundary is what lets one package render inside both a Tauri webview and an
// Electron renderer.

import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";

// ── Command palette ──────────────────────────────────────────────────────────

/**
 * One runnable entry in the palette. Apps build a flat `CommandAction[]`; the
 * palette groups them by `group` (in first-seen order) and renders each with the
 * shared `@ryu/ui` command primitives. Actions are decoupled from any app's
 * contexts — the consumer owns what `onSelect` does.
 */
export interface CommandAction {
	/** Render the selected-state checkmark (e.g. the active theme). */
	checked?: boolean;
	/** Disable selection (e.g. a sign-out in flight). */
	disabled?: boolean;
	/** Group heading this action renders under. First-seen order is preserved. */
	group: string;
	/** Optional leading HugeIcon. Rows without one align like the desktop chats. */
	icon?: IconSvgElement;
	/** Stable identity (also the React key). */
	id: string;
	/** Extra search terms folded into the default `value`. */
	keywords?: string;
	/** Invoked when the row is chosen. The consumer owns the side effect. */
	onSelect: () => void;
	/** Right-aligned keyboard hint (e.g. `⌘N`). Mutually exclusive with `trailing`. */
	shortcut?: string;
	/** Primary label shown in the row. */
	title: string;
	/** Right-aligned custom node (e.g. a folder path). Takes precedence over `shortcut`. */
	trailing?: ReactNode;
	/**
	 * The cmdk search value (what fuzzy search matches against). Defaults to
	 * `"<group> <title> <keywords>"` when omitted. Supply explicitly to match the
	 * exact search terms a row should answer to.
	 */
	value?: string;
}

// ── Chat transport (injected) ────────────────────────────────────────────────

/** A single message in the shared mini-chat. */
export interface ChatMessage {
	content: string;
	id: string;
	role: "user" | "assistant";
	/** True while the assistant message is still streaming. */
	streaming?: boolean;
}

/** Callbacks the injected transport drives as a stream progresses. */
export interface ChatStreamHandlers {
	/** Append a chunk of assistant text. */
	onDelta(delta: string): void;
	/** The stream finished cleanly. */
	onDone(): void;
	/** The stream failed; `message` is human-readable. */
	onError(message: string): void;
}

/** Handle returned by a transport so the chat view can abort an in-flight turn. */
export interface ChatStreamHandle {
	abort(): void;
}

/**
 * The injected streaming function. Given the full message history (the trailing
 * entry is the new user turn), start a run and drive `handlers`; return a handle
 * the view uses to abort. Each consumer wires this to its own backend.
 */
export type ChatStreamFn = (
	messages: ChatMessage[],
	handlers: ChatStreamHandlers
) => ChatStreamHandle;
