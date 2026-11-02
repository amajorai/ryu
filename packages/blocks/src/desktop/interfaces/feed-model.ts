import { translate as tr } from "@ryu/i18n/lite";
import {
	type FeedPost,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { threadStatusLabel } from "./interface-renderer.ts";

/**
 * The quiet text marker a post carries in its meta line: a short form for the
 * timeline header ("Failed") and a long one for the post page ("Run failed").
 * Working threads use the live dot instead; quiet threads carry nothing.
 */
export interface FeedStatusMarker {
	long: string;
	short: string;
	status: ThreadStatus;
}

export function feedThreadOf(
	snapshot: InterfaceSnapshot,
	threadId: string
): InterfaceThread | undefined {
	return snapshot.threads.find((item) => item.id === threadId);
}

/** The thread's status, or quiet when the snapshot no longer lists it. */
export function feedPostStatus(
	snapshot: InterfaceSnapshot,
	post: FeedPost
): ThreadStatus {
	const thread = feedThreadOf(snapshot, post.threadId);
	if (!thread) {
		return post.running ? "working" : "quiet";
	}
	return threadStatus(thread);
}

export function feedStatusMarker(
	status: ThreadStatus,
	thread: InterfaceThread | undefined
): FeedStatusMarker | null {
	if (status === "attention") {
		const stopped = thread?.runState === "interrupted";
		return {
			long: stopped ? tr("Run stopped") : tr("Run failed"),
			short: stopped ? tr("Stopped") : tr("Failed"),
			status,
		};
	}
	if (status === "your-turn") {
		return {
			long: threadStatusLabel("your-turn"),
			short: threadStatusLabel("your-turn"),
			status,
		};
	}
	if (status === "waiting") {
		return {
			long: threadStatusLabel("waiting"),
			short: tr("Waiting"),
			status,
		};
	}
	return null;
}

/** Threads that are blocked on the user: a failed run, or a reply to read. */
export function needsYou(status: ThreadStatus): boolean {
	return status === "attention" || status === "your-turn";
}
