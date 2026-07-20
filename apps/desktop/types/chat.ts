export interface Agent {
	description: string;
	id: string;
	name: string;
}

export interface Message {
	content: string;
	id: string;
	/** The message this one replied to (its parent in the version tree). */
	parentMessageId?: string;
	/**
	 * Structured render parts (AI SDK reduced UIMessage `parts`) rehydrated from
	 * Core when present — tool / text / file parts captured server-side as the turn
	 * streamed. Lets a reloaded conversation re-render its tool rows + cowork
	 * context instead of collapsing to flat `content`. Absent for user turns and
	 * for messages persisted before parts capture existed (fall back to a text part
	 * built from `content`).
	 */
	parts?: unknown[];
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
	timestamp: number;
}

export interface Conversation {
	agentId?: string;
	/** Server-backed archive (shared with coordinator threads). */
	archived?: boolean;
	/** Git branch at run start (M1). */
	branch?: string;
	createdAt: number;
	/** Active working folder at run start (M1). */
	folderPath?: string;
	id: string;
	messages: Message[];
	/** Agent ids participating in this conversation (council / multi-agent). */
	participants?: string[];
	/** Server-backed pin (shared with coordinator threads). */
	pinned?: boolean;
	/** Run lifecycle status: "running" | "completed" | "failed" | undefined. */
	runStatus?: string;
	title: string;
	updatedAt: number;
	/** Per-run worktree path, when a dedicated worktree was created (M1). */
	worktreePath?: string;
}
