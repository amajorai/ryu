// One-shot cache for fetches started ahead of need (hover or focus on a link).
//
// An entry is used at most once, only while younger than `ttlMs`, and only if
// the caller's `version` still matches the one recorded when the fetch started
// (a conversation's `updatedAt`, say): a change in between means the prefetched
// data may already be stale, so the caller fetches again instead.

interface PrefetchEntry<T> {
	promise: Promise<T>;
	startedAt: number;
	version: unknown;
}

export interface PrefetchCache<T> {
	/** Start `load` for `key` unless a fresh fetch for it is already held. */
	start: <TVersion>(
		key: string,
		version: TVersion,
		load: () => Promise<T>
	) => void;
	/** Remove and return the held fetch for `key` if it is still usable. */
	take: <TVersion>(key: string, version: TVersion) => Promise<T> | undefined;
}

export function createPrefetchCache<T>(
	ttlMs: number,
	now: () => number = Date.now
): PrefetchCache<T> {
	const entries = new Map<string, PrefetchEntry<T>>();
	const isFresh = (entry: PrefetchEntry<T>, at: number) =>
		at - entry.startedAt < ttlMs;

	return {
		start(key, version, load) {
			const at = now();
			for (const [staleKey, entry] of entries) {
				if (!isFresh(entry, at)) {
					entries.delete(staleKey);
				}
			}
			if (entries.has(key)) {
				return;
			}
			entries.set(key, { promise: load(), startedAt: at, version });
		},
		take(key, version) {
			const entry = entries.get(key);
			entries.delete(key);
			if (!(entry && isFresh(entry, now()) && entry.version === version)) {
				return undefined;
			}
			return entry.promise;
		},
	};
}
