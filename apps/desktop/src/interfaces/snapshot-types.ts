// The inputs of the interface snapshot adapter (`snapshot.ts`).

import type {
	InterfaceAccount,
	InterfaceAgentLimit,
	InterfaceEvent,
} from "@ryuhq/protocol/interfaces";
import type { ApprovalRequest } from "@/src/lib/api/approvals.ts";
import type { ScheduledJob } from "@/src/lib/api/schedules.ts";
import type { Conversation } from "@/types/chat.ts";
import type { SnapshotTranslate } from "./snapshot-util.ts";
import type { InterfaceDetailInput } from "./use-interface-detail.ts";

/**
 * Most recent threads an interface receives. Older ones are left out of the
 * snapshot; the interface's top bar says how many (see
 * {@link omittedInterfaceThreads}) and they stay reachable from the Console
 * sidebar and search.
 */
export const MAX_INTERFACE_THREADS = 500;

export interface SnapshotAgentInput {
	avatarUrl: string | null;
	description: string | null;
	id: string;
	/** The agent's configured model id, when known. */
	model?: string | null;
	name: string;
}

export interface SnapshotTeamInput {
	id: string;
	members: readonly string[];
	name: string;
}

export interface SnapshotProjectInput {
	id: string;
	name: string;
}

/** A run-stream row's status and its write time (epoch ms, as Core sends it). */
export interface RunFrameStatus {
	run_status: string | null;
	/** Epoch ms from the same `conversations.updated_at` column as
	 *  `Conversation.updatedAt`; never rescale either. */
	updated_at: number;
}

/** How this session saw a run end: exact only from a completed / failed delta. */
export interface TerminalSeen {
	approx: boolean;
	atMs: number;
	/** The terminal status and row write time it was recorded from; a later
	 *  frame that changes either belongs to another run and drops the entry. */
	status?: string;
	updatedAt?: number;
}

/** The push and list inputs `use-interface-live` collects for the snapshot. */
export interface InterfaceLiveInput {
	/** Pending approvals (Core-filtered), or undefined when not loaded. */
	approvals?: readonly ApprovalRequest[];
	/** Receipt time of the frame that first showed an id `awaiting_input`. */
	awaitingSince?: ReadonlyMap<string, number>;
	/** Receipt time of the first `running` frame of the CURRENT run per id. */
	firstSeenRunning: ReadonlyMap<string, number>;
	/** Polled subscription windows per agent: absent = never polled,
	 *  null = usage unknown. */
	limits?: ReadonlyMap<string, InterfaceAgentLimit | null>;
	privacy: "full" | "redacted";
	/** Latest run-stream row per conversation id. */
	runs: ReadonlyMap<string, RunFrameStatus>;
	terminalSeen: ReadonlyMap<string, TerminalSeen>;
	/** Unread message count per conversation id. */
	unread: ReadonlyMap<string, number>;
}

export interface BuildInterfaceSnapshotInput {
	/** The usage account, when the active interface shows it. */
	account?: InterfaceAccount;
	agents: readonly SnapshotAgentInput[];
	conversations: readonly Conversation[];
	/** Message-derived detail (1b) and live-tab entries (1c), when hydrated. */
	detail?: InterfaceDetailInput;
	/** Scheduled runs, when the active interface shows them. */
	events?: readonly InterfaceEvent[];
	/** Scheduled jobs behind `events`, for linking a run to its cron routine. */
	jobs?: readonly ScheduledJob[];
	/** Live run, approval, unread and privacy inputs. Without them the snapshot
	 *  carries list fields only, exactly as older hosts send it. */
	live?: InterfaceLiveInput;
	/** The host clock for this build (epoch ms). Required with `live`. */
	nowMs?: number;
	projects?: readonly SnapshotProjectInput[];
	teams: readonly SnapshotTeamInput[];
	/** Translates the copy the snapshot writes itself (ask labels and
	 *  questions, blocker titles); the UI's active locale by default. */
	translate?: SnapshotTranslate;
}
