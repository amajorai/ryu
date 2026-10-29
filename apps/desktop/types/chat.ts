import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import type { UIMessage } from "ai";
import type { TemporaryChatMessageInput } from "@/src/lib/api/temporary-chat.ts";
import type { ResourceVisibility } from "@/src/lib/resource-visibility.ts";

export interface Agent {
	description: string;
	id: string;
	name: string;
}

export interface Message {
	/** Verified human author for shared team conversations. Absent on local
	 * messages and agent replies. */
	author?: {
		id: string;
		name?: string;
	};
	content: string;
	id: string;
	/**
	 * This assistant turn was cut off mid-stream and never finalized — the node
	 * died while it was still being written, so `content`/`parts` hold only what
	 * had been flushed. Stamped by Core's boot reconciliation (nothing can mark it
	 * live: a process that dies never gets to say so), and rendered as an explicit
	 * "cut off" marker rather than passing a truncated reply off as a whole one.
	 */
	interrupted?: boolean;
	/** Client display metadata persisted by Core; identity comes from author/provenance. */
	metadata?: TemporaryChatMessageInput["metadata"];
	originServer?: string;
	/** The message this one replied to (its parent in the version tree). */
	parentMessageId?: string;
	/**
	 * Structured render parts (AI SDK reduced UIMessage `parts`) rehydrated from
	 * Core when present — tool / text / file parts captured server-side as the turn
	 * streamed. Lets a reloaded conversation re-render its tool rows + cowork
	 * context instead of collapsing to flat `content`. User text/file parts are
	 * preserved too. Absent for legacy rows (fall back to a text part
	 * built from `content`).
	 */
	parts?: UIMessage["parts"];
	/** True when this row came from Core rather than an optimistic client copy. */
	persisted?: boolean;
	role: "user" | "assistant";
	siblingCount?: number;
	/** Ids of every version at this branch point in pager order (v1..vN); lets the
	 * pager map a step to a `selectVersion` target. Empty for unbranched turns. */
	siblingIds?: string[];
	/**
	 * Version-tree position (ChatGPT/Claude-style edit + regenerate branching).
	 * `siblingCount > 1` means this turn has alternate versions and the client
	 * renders a `< n / m >` pager; `siblingIndex` is the 0-based active version.
	 * Both come from Core's active-path read; absent/1 for never-branched turns.
	 */
	siblingIndex?: number;
	source?: string;
	timestamp: number;
	widgetInstanceId?: string;
}

export interface Conversation {
	agentId?: string;
	/** Server-backed archive (shared with coordinator threads). */
	archived?: boolean;
	/** Git branch at run start (M1). */
	branch?: string;
	/** Set on the source after an RNP handoff: the thread now continues there. */
	continuedOn?: { nodeLabel: string; at: number };
	createdAt: number;
	/** Active working folder at run start (M1). */
	folderPath?: string;
	/** Where the thread sits in the Projects › Bots/Groups › Sessions hierarchy. */
	hierarchy?: ThreadHierarchy;
	/** Notion-style glyph from the shared GlyphPicker; null/undefined = title only. */
	icon?: GlyphValue;
	id: string;
	/** One flattened line of the newest message, for messaging-style rows. Only
	 * populated while the sidebar asks Core for previews (`?preview=1`); every
	 * other load leaves it undefined. */
	lastMessage?: string;
	/** Unix ms of that message — distinct from `updatedAt`, which also moves on
	 * renames, pins and run-status writes. */
	lastMessageAt?: number;
	/** Role that wrote it, so a row can prefix "You: ". */
	lastMessageRole?: string;
	/** GitHub pull request URLs explicitly linked to this chat. The PR owned by
	 * `branch` is implicit and is not listed here. */
	linkedPullRequests?: string[];
	/** Authoritative message total returned by Core's conversation summary. */
	messageCount?: number;
	messages: Message[];
	/** Agent ids participating in this conversation (council / multi-agent). */
	participants?: string[];
	/** Server-backed pin (shared with coordinator threads). */
	pinned?: boolean;
	/** Run lifecycle status: "running" | "completed" | "failed" | "interrupted" |
	 * undefined. "interrupted" is stamped by Core's boot reconciliation on a run
	 * the node died in the middle of; it is TERMINAL, so "is this live?" checks
	 * must keep testing for "running" specifically. */
	runStatus?: string;
	title: string;
	updatedAt: number;
	/** Owner-only or shared visibility inherited from the Core conversation row. */
	visibility?: ResourceVisibility;
	/** Per-run worktree path, when a dedicated worktree was created (M1). */
	worktreePath?: string;
}

/** Who a main (coordinator) thread belongs to. */
export type ThreadOwnerKind = "agent" | "group" | "project";

/**
 * A conversation's place in the Projects › Bots/Groups › Sessions hierarchy.
 * Users talk to MAIN threads (a project's, a bot's or a group's coordinator
 * thread); the work happens in SESSIONS those main threads spawn.
 */
export interface ThreadHierarchy {
	/** Coordination strategy of an ad-hoc group's main thread. */
	coordination?: string;
	/** Owning project/agent/group id, on a main thread. */
	ownerId?: string;
	ownerKind?: ThreadOwnerKind;
	/** Opaque project id, when the thread is in a project. */
	projectId?: string;
	role: "main" | "session";
	/** The main thread whose turn spawned this session. */
	spawnedByConversationId?: string;
	spawnedByMessageId?: string;
}
