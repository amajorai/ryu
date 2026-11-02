// The shapes of the phase-1b detail deriver (`interface-detail.ts`).

import type {
	InterfaceActivity,
	InterfaceAsk,
	InterfaceBlocker,
	InterfaceOutcome,
	InterfaceProgress,
} from "@ryuhq/protocol/interfaces";

/** The message fields the deriver reads (persisted `Message` satisfies it). */
export interface DetailMessage {
	content?: string;
	id: string;
	interrupted?: boolean;
	parts?: readonly unknown[];
	role: "assistant" | "user";
	timestamp: number;
}

export interface DeriveDetailExtras {
	/** Agent of the conversation that holds the parts. */
	agentId: string | null;
	/** Older messages exist before this page (counts at the boundary are absent). */
	hasOlder: boolean;
	/** Where this conversation's asks surface: a helper session lifts them to
	 *  its parent main thread. Defaults to the conversation itself. */
	liftTo?: { agentId: string | null; threadId: string };
	nowMs: number;
	/** The conversation itself is running (questions block only then). */
	running: boolean;
	/** Conversation id that holds the parts. */
	threadId: string;
}

/** Newest step and message times (ms): over the whole page, and over the
 *  current turn only (after the newest user message), for when the host
 *  knows no run start to floor them by. */
export interface ProgressMarks {
	messageAt: number | null;
	partAt: number | null;
	turnMessageAt: number | null;
	turnPartAt: number | null;
}

export interface ThreadDetail {
	activity: InterfaceActivity | null;
	blocker: InterfaceBlocker | null;
	/** An assistant message exists after the last user message. */
	hasLaterAssistant: boolean;
	outcome: InterfaceOutcome | null;
	progress: InterfaceProgress | null;
	/** Newest tool timing and newest assistant message time on the page (ms),
	 *  so the host can floor them by the run start it resolves (spec order:
	 *  a part timing at or after the start, else a message, else the start). */
	progressMarks: ProgressMarks;
	/** Open Question cards, with the conversation each answer posts to. */
	questionAsks: Array<{
		ask: InterfaceAsk;
		holderId: string;
		toolCallId: string;
	}>;
	/** When the last user message was sent (ms), or the earliest tool start
	 *  after it when the message has no time. Null without a user message. */
	userStart: number | null;
}
