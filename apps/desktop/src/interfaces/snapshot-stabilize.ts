// Snapshot identity: unchanged threads keep their object, and the usage
// account is attached (and redacted again) after the build.

import {
	type InterfaceAccount,
	type InterfaceSnapshot,
	type InterfaceThread,
	redactSnapshot,
} from "@ryuhq/protocol/interfaces";

/**
 * Reuse the previous snapshot's thread objects where nothing changed, so a
 * step change in one thread does not hand renderers 500 new threads (spec
 * §3.1, risk 4). Pure: equal content keeps the old reference.
 */
export function stabilizeSnapshot(
	previous: InterfaceSnapshot | null,
	next: InterfaceSnapshot
): InterfaceSnapshot {
	if (!previous) {
		return next;
	}
	const before = new Map(previous.threads.map((thread) => [thread.id, thread]));
	let changed = previous.threads.length !== next.threads.length;
	const threads = next.threads.map((thread, index) => {
		const old = before.get(thread.id);
		const same = old !== undefined && sameThread(old, thread);
		if (!same || previous.threads[index] !== old) {
			changed = true;
		}
		return same && old ? old : thread;
	});
	return {
		...next,
		threads: changed ? threads : previous.threads,
	};
}

/** Each thread object is serialized at most once (objects are immutable). */
const serialized = new WeakMap<InterfaceThread, string>();

function serialize(thread: InterfaceThread): string {
	let text = serialized.get(thread);
	if (text === undefined) {
		text = JSON.stringify(thread);
		serialized.set(thread, text);
	}
	return text;
}

/** A cheap key of what usually changes; only equal keys pay for a deep compare. */
function threadKey(thread: InterfaceThread): string {
	return [
		thread.updatedAt,
		thread.messageCount,
		thread.running,
		thread.runState,
		thread.unread,
		thread.detail,
		thread.activity?.label,
		thread.activity?.since,
		thread.progress?.done,
		thread.blocker?.kind,
		thread.lastProgressAt,
	].join("|");
}

function sameThread(a: InterfaceThread, b: InterfaceThread): boolean {
	if (a === b) {
		return true;
	}
	return threadKey(a) === threadKey(b) && serialize(a) === serialize(b);
}

/**
 * Attach the usage account to a built snapshot. The account is loaded after
 * the build (it links spend to the snapshot's threads), so a redacted
 * snapshot is redacted again with it: ledger labels are user content too.
 */
export function withInterfaceAccount(
	snapshot: InterfaceSnapshot,
	account: InterfaceAccount | undefined
): InterfaceSnapshot {
	if (!account) {
		return snapshot;
	}
	const merged = { ...snapshot, account };
	return snapshot.privacy === "redacted" ? redactSnapshot(merged) : merged;
}
