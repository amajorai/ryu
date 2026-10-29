"use client";

// Persistent, VERSION-KEYED cache for app/plugin icon art.
//
// Every icon an installed app shows is a remote fetch: an Iconify glyph from
// api.iconify.design, an svgl brand mark, or a raster logo on a GitHub CDN. That
// means a cold launch paints empty squares until the network answers, an offline
// launch paints them forever, and the same bytes are re-requested on every boot for
// art that changes roughly never.
//
// The fix is the one a phone's app grid uses: an app's icon is part of the INSTALL,
// not part of the render. Each entry is keyed by `<id>@<version>`, so the bytes are
// re-fetched exactly when the app's installed version moves and at no other time —
// no TTL to tune and no revalidation request whose whole purpose is to be told
// "unchanged". A publisher who swaps art without cutting a version keeps showing the
// old icon until the next update, which is the deliberate trade: predictable and
// offline-complete beats eventually-fresh for a 20px square.
//
// Bytes are stored as `data:` URIs so a cached icon needs no network at paint time
// and survives a restart. `localStorage` is the store because the cache must be
// readable SYNCHRONOUSLY during the first render — an async store (IndexedDB, the
// Cache API) would still flash the placeholder on every launch, which is the exact
// symptom this exists to remove.
//
// What is deliberately NOT cached: an already-inline `data:` URI (nothing to fetch)
// and anything that fails to fetch (a failure must never be sticky — the next launch
// retries).

import {
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { useEffect, useState } from "react";
import { z } from "zod";

/** localStorage key prefix. One entry per `<id>@<version>` per source URL. */
const PREFIX = "ryu:icon-cache:";

/** Hard cap on entries. At ~4 KB of base64 per glyph this keeps the whole cache
 *  around 500 KB — well inside the ~5 MB localStorage budget it SHARES with
 *  everything else the shell persists. Overflow evicts oldest-written first. */
const MAX_ENTRIES = 120;

/** Refuse to store anything larger than this (base64-inflated). A listing pointing
 *  at a 2 MB PNG would otherwise evict the entire cache to hold one icon. */
const MAX_BYTES = 64 * 1024;

const cacheEntrySchema = z.object({
	/** The fetched art and the original source URL. */
	data: z.string(),
	url: z.string(),
	/** Legacy entries lacking a numeric write time are treated as oldest. */
	storedAt: z.custom<number>(isNativeNumber).catch(0),
});

type CacheEntry = z.output<typeof cacheEntrySchema>;

function storage(): Storage | null {
	try {
		return globalThis.localStorage === undefined ? null : localStorage;
	} catch {
		// Storage can throw outright (disabled cookies, sandboxed iframe).
		return null;
	}
}

/** The cache key for one app's icon at one installed version. `version` may be
 *  null for something with no version (a built-in), which then caches under a
 *  stable `@-` key and refreshes only when the URL changes. */
export function iconCacheKey(
	id: string | null | undefined,
	version: string | null | undefined
): string | null {
	const trimmed = id?.trim();
	if (!trimmed) {
		return null;
	}
	return `${trimmed}@${version?.trim() || "-"}`;
}

function readEntry(key: string): CacheEntry | null {
	const store = storage();
	if (!store) {
		return null;
	}
	const raw = store.getItem(PREFIX + key);
	if (!raw) {
		return null;
	}
	try {
		const parsed = cacheEntrySchema.safeParse(JSON.parse(raw));
		if (parsed.success) {
			return parsed.data;
		}
	} catch {
		// A corrupt entry is a miss, not a crash.
	}
	store.removeItem(PREFIX + key);
	return null;
}

/** Every cache key currently held, oldest write first. */
function entriesByAge(store: Storage): { key: string; storedAt: number }[] {
	const rows: { key: string; storedAt: number }[] = [];
	for (let i = 0; i < store.length; i++) {
		const key = store.key(i);
		if (!key?.startsWith(PREFIX)) {
			continue;
		}
		let storedAt = 0;
		try {
			const parsed = cacheEntrySchema.safeParse(
				JSON.parse(store.getItem(key) ?? "{}")
			);
			storedAt = parsed.success ? parsed.data.storedAt : 0;
		} catch {
			// Unparseable → treat as ancient so it is evicted first.
		}
		rows.push({ key, storedAt: storedAt || 0 });
	}
	rows.sort((a, b) => a.storedAt - b.storedAt);
	return rows;
}

function writeEntry(key: string, entry: CacheEntry): void {
	const store = storage();
	if (!store) {
		return;
	}
	const payload = JSON.stringify(entry);
	if (payload.length > MAX_BYTES) {
		return;
	}
	const rows = entriesByAge(store);
	for (let i = 0; i <= rows.length - MAX_ENTRIES; i++) {
		const victim = rows[i];
		if (victim) {
			store.removeItem(victim.key);
		}
	}
	try {
		store.setItem(PREFIX + key, payload);
	} catch {
		// Quota exceeded even after eviction: drop the oldest half and give up on
		// this write rather than throwing inside a render.
		const remaining = entriesByAge(store);
		for (let i = 0; i < Math.ceil(remaining.length / 2); i++) {
			const victim = remaining[i];
			if (victim) {
				store.removeItem(victim.key);
			}
		}
	}
}

/** A cached `data:` URI for this key, or null. Synchronous by design — the first
 *  render must be able to paint real art with no network and no placeholder flash. */
export function readCachedIcon(
	key: string | null,
	url: string | null | undefined
): string | null {
	if (!(key && url)) {
		return null;
	}
	const entry = readEntry(key);
	return entry && entry.url === url ? entry.data : null;
}

/** In-flight fetches, so N cards sharing one icon URL make ONE request. */
const inFlight = new Map<string, Promise<string | null>>();

function toDataUri(blob: Blob): Promise<string | null> {
	return new Promise((resolve) => {
		const reader = new FileReader();
		reader.onerror = () => resolve(null);
		reader.onload = () =>
			resolve(isNativeText(reader.result) ? reader.result : null);
		reader.readAsDataURL(blob);
	});
}

/**
 * Fetch `url` once and persist it under `key`. Resolves with the `data:` URI, or
 * null when it could not be cached — in which case the caller simply keeps
 * rendering the remote URL, so a failure costs nothing beyond staying uncached.
 *
 * A failed fetch is never written: the point of the cache is to survive being
 * offline, and persisting "this icon is broken" would make one bad launch
 * permanent.
 */
export async function cacheIcon(
	key: string | null,
	url: string | null | undefined
): Promise<string | null> {
	if (!(key && url) || url.startsWith("data:")) {
		return null;
	}
	const cacheId = `${key}|${url}`;
	const existing = inFlight.get(cacheId);
	if (existing) {
		return existing;
	}
	const task = (async () => {
		try {
			const res = await fetch(url);
			if (!res.ok) {
				return null;
			}
			const blob = await res.blob();
			if (blob.size > MAX_BYTES) {
				return null;
			}
			const data = await toDataUri(blob);
			if (data) {
				writeEntry(key, { data, storedAt: Date.now(), url });
			}
			return data;
		} catch {
			return null;
		} finally {
			inFlight.delete(cacheId);
		}
	})();
	inFlight.set(cacheId, task);
	return task;
}

/**
 * Resolve one remote icon URL through the persistent, version-keyed cache.
 *
 * Returns the cached `data:` URI when there is one — read SYNCHRONOUSLY on every
 * render, so a warm icon paints with no network and no placeholder flash — and
 * otherwise the original URL, warming the cache in the background. Passing no
 * `cacheKey` disables caching entirely and hands the URL straight back, which is
 * what every catalog-browse surface wants: those listings are not installed, have
 * no version to key on, and would otherwise fill the cache with art for apps the
 * user only scrolled past.
 *
 * The cache is read DURING RENDER rather than seeded into `useState`, and the
 * background result is stamped with the `(key, url)` it was fetched for. Both
 * exist for the same reason: this hook's inputs change on a component that does
 * NOT remount. The Installed tab's detail panel is one `AppIcon` whose props swap
 * as you click from app A to app B, so a `useState` initializer — which runs only
 * on mount — would keep returning A's bytes until an effect flushed, painting the
 * wrong app's icon in B's hero. Deriving from the current props each render makes
 * that frame impossible.
 */
export function useCachedIconUrl(
	url: string | null,
	cacheKey: string | null | undefined
): string | null {
	const key = cacheKey ?? null;
	// Synchronous, and cheap: one `getItem` + `JSON.parse`. Already guarded on the
	// source URL, so a key whose art moved within one version reads as a miss.
	const cached = readCachedIcon(key, url);
	// A just-fetched entry, tagged with what it was fetched FOR. Never trusted
	// unless both halves still match the props being rendered.
	const [warmed, setWarmed] = useState<{
		data: string;
		key: string;
		url: string;
	} | null>(null);

	useEffect(() => {
		if (!(key && url) || url.startsWith("data:") || readCachedIcon(key, url)) {
			return;
		}
		let live = true;
		cacheIcon(key, url)
			.then((data) => {
				if (live && data) {
					setWarmed({ data, key, url });
				}
			})
			.catch(() => {
				// Uncached is not an error — the remote URL still renders.
			});
		return () => {
			live = false;
		};
	}, [key, url]);

	if (cached) {
		return cached;
	}
	if (warmed && warmed.key === key && warmed.url === url) {
		return warmed.data;
	}
	return url;
}
