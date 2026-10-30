import type { InterfaceThread } from "@ryuhq/protocol/interfaces";
import { useEffect, useState } from "react";

const FIRST_SEEN_KEY = "ryu.interfaces.passport.first-seen";
const FIRST_SEEN_LIMIT = 500;

function readFirstSeen(): Record<string, string> {
	try {
		const raw = window.localStorage.getItem(FIRST_SEEN_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : null;
		if (!parsed || typeof parsed !== "object") {
			return {};
		}
		const result: Record<string, string> = {};
		for (const [id, value] of Object.entries(parsed)) {
			if (typeof value === "string") {
				result[id] = value;
			}
		}
		return result;
	} catch {
		return {};
	}
}

/**
 * Persist first-seen times. Threads still in the snapshot are always kept, so
 * their entry dates never reset; only threads that have left it are trimmed
 * (newest first-seen kept) to stay under the limit.
 */
function writeFirstSeen(
	map: Record<string, string>,
	currentIds: ReadonlySet<string>
): void {
	try {
		const entries = Object.entries(map);
		const current = entries.filter(([id]) => currentIds.has(id));
		const departed = entries
			.filter(([id]) => !currentIds.has(id))
			.sort((a, b) => b[1].localeCompare(a[1]))
			.slice(0, Math.max(0, FIRST_SEEN_LIMIT - current.length));
		window.localStorage.setItem(
			FIRST_SEEN_KEY,
			JSON.stringify(Object.fromEntries([...current, ...departed]))
		);
	} catch {
		// Storage can be blocked; entry dates then fall back to latest activity.
	}
}

/**
 * The earliest time this viewer has seen each thread, kept per browser, so a
 * stamp's entry date can stay put while its latest date moves on.
 */
export function useFirstSeen(
	threads: InterfaceThread[]
): Record<string, string> {
	const [firstSeen, setFirstSeen] = useState<Record<string, string>>({});
	useEffect(() => {
		const stored = readFirstSeen();
		let changed = false;
		for (const thread of threads) {
			const known = stored[thread.id];
			if (!known || thread.updatedAt < known) {
				stored[thread.id] = thread.updatedAt;
				changed = true;
			}
		}
		if (changed) {
			writeFirstSeen(stored, new Set(threads.map((thread) => thread.id)));
		}
		setFirstSeen(stored);
	}, [threads]);
	return firstSeen;
}
