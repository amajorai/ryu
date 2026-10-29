// Favorites + recents stores backing the unified Library page. Both are thin,
// localStorage-backed sets of "references" — a `{ type, id }` pointer to a real
// item (an agent, workflow, chat, space, team, meeting, channel, or identity)
// that lives behind its own data hook. The Library page resolves these refs
// against the live hooks and drops any that no longer resolve (the underlying
// item was deleted), so a stale favorite or recent never renders a blank card.
//
// This module owns its storage keys, change events, load/persist helpers and the
// React subscriptions — mirroring `lib/features.ts`. Nothing here imports a page
// or hook, so there is no import cycle.

import {
	type AppRequestValue,
	appRequestValueSchema,
} from "@ryuhq/core-client/app-request-json.ts";
import { useEffect, useState } from "react";
import { z } from "zod";

/** The kinds of thing the Library can hold a reference to. */
export type LibraryItemType =
	| "agent"
	| "workflow"
	| "chat"
	| "space"
	| "team"
	| "meeting"
	| "channel"
	| "identity";

/** A pointer to a real item, resolved against its data hook at render time. */
export interface LibraryRef {
	id: string;
	type: LibraryItemType;
}

/** A recents entry: a ref plus the epoch-ms timestamp it was last opened. */
export interface RecentEntry extends LibraryRef {
	ts: number;
}

/** localStorage key holding the JSON array of favorite refs. */
export const FAVORITES_KEY = "ryu:library-favorites";
/** localStorage key holding the JSON array of recents entries (most-recent first). */
export const RECENTS_KEY = "ryu:library-recents";

/** Fired whenever favorites change, so every mounted surface re-syncs. */
export const FAVORITES_CHANGED_EVENT = "ryu:library-favorites-changed";
/** Fired whenever recents change, so every mounted surface re-syncs. */
export const RECENTS_CHANGED_EVENT = "ryu:library-recents-changed";

/** How many recents to retain. Older entries fall off the end. */
const RECENTS_LIMIT = 60;

/** Stable string key for a ref, used for de-duplication and Set membership. */
export function refKey(type: LibraryItemType, id: string): string {
	return `${type}:${id}`;
}

/**
 * Coerce a timestamp from any data hook into epoch milliseconds. The hooks are
 * inconsistent: Space/Conversation use epoch numbers, Workflow/Team use ISO
 * strings (nullable), Meeting uses snake_case ISO strings, and agents have no
 * update time at all. Everything funnels through here so cross-type sorting
 * compares like with like. Unparseable / missing values fall back to 0 (sorts
 * last in a descending "most recent" order), which is the deliberate home for
 * agents and any item without a real timestamp.
 */
export function normalizeTimestamp(
	value: number | string | null | undefined
): number {
	const numeric = z.number().safeParse(value);
	if (numeric.success) {
		return numeric.data < 1e11 ? numeric.data * 1000 : numeric.data;
	}
	const text = z.string().min(1).safeParse(value);
	if (text.success) {
		const parsed = Date.parse(text.data);
		return Number.isNaN(parsed) ? 0 : parsed;
	}
	return 0;
}

const libraryRefFieldsSchema = z.object({
	id: z.string(),
	type: z.enum([
		"agent",
		"workflow",
		"chat",
		"space",
		"team",
		"meeting",
		"channel",
		"identity",
	]),
});
const recentEntryFieldsSchema = libraryRefFieldsSchema.extend({
	ts: z.union([
		z.number(),
		z.literal(Number.POSITIVE_INFINITY),
		z.literal(Number.NEGATIVE_INFINITY),
	]),
});
const libraryRefSchema = z.custom<LibraryRef>(
	(value) => libraryRefFieldsSchema.safeParse(value).success
);
const recentEntrySchema = z.custom<RecentEntry>(
	(value) => recentEntryFieldsSchema.safeParse(value).success
);
const libraryRawSnapshotSchema = z.array(appRequestValueSchema);
const libraryRefIdentitySchema = z.object({ id: z.string(), type: z.string() });

/** Keep the complete stored snapshot for mutations, including future item kinds
 * and malformed legacy entries. Only reader projections refine current refs. */
function readLibrarySnapshot(key: string): AppRequestValue[] {
	try {
		const stored = localStorage.getItem(key);
		if (!stored) {
			return [];
		}
		const parsed = libraryRawSnapshotSchema.safeParse(JSON.parse(stored));
		return parsed.success ? parsed.data : [];
	} catch {
		return [];
	}
}
function matchesLibraryRef(
	value: AppRequestValue,
	type: LibraryItemType,
	id: string
): boolean {
	const parsed = libraryRefIdentitySchema.safeParse(value);
	return parsed.success && parsed.data.type === type && parsed.data.id === id;
}

// --- Favorites ------------------------------------------------------------

/** Read the current favorites list fresh from storage. */
export function loadFavorites(): LibraryRef[] {
	return readLibrarySnapshot(FAVORITES_KEY).flatMap((value) => {
		const parsed = libraryRefSchema.safeParse(value);
		return parsed.success ? [parsed.data] : [];
	});
}

function persistFavorites(refs: AppRequestValue[]) {
	try {
		localStorage.setItem(FAVORITES_KEY, JSON.stringify(refs));
	} catch {
		// best-effort; still notify so in-memory state stays consistent
	}
	window.dispatchEvent(new CustomEvent(FAVORITES_CHANGED_EVENT));
}

/** Whether the given item is currently favorited. */
export function isFavorite(
	favorites: LibraryRef[],
	type: LibraryItemType,
	id: string
): boolean {
	return favorites.some((f) => f.type === type && f.id === id);
}

/**
 * Toggle an item's favorite status. Always loads fresh before mutating so a
 * concurrent writer can't be clobbered by a stale React snapshot.
 */
export function toggleFavorite(type: LibraryItemType, id: string) {
	const favorites = readLibrarySnapshot(FAVORITES_KEY);
	const exists = favorites.some((value) => matchesLibraryRef(value, type, id));
	const next = exists
		? favorites.filter((value) => !matchesLibraryRef(value, type, id))
		: [{ type, id }, ...favorites];
	persistFavorites(next);
}

// --- Recents --------------------------------------------------------------

/** Read the current recents list fresh from storage (most-recent first). */
export function loadRecents(): RecentEntry[] {
	return readLibrarySnapshot(RECENTS_KEY).flatMap((value) => {
		const parsed = recentEntrySchema.safeParse(value);
		return parsed.success ? [parsed.data] : [];
	});
}

function persistRecents(entries: AppRequestValue[]) {
	try {
		localStorage.setItem(RECENTS_KEY, JSON.stringify(entries));
	} catch {
		// best-effort; still notify so in-memory state stays consistent
	}
	window.dispatchEvent(new CustomEvent(RECENTS_CHANGED_EVENT));
}

/**
 * Record that an item was just opened. Moves it to the front of the recents
 * list (de-duping any prior entry) and trims to {@link RECENTS_LIMIT}. The
 * timestamp is captured here, at the moment of opening, so recency is true
 * "recently visited" and uniform across every item type.
 */
export function stampRecent(type: LibraryItemType, id: string) {
	if (!id) {
		return;
	}
	const now = Date.now();
	const without = readLibrarySnapshot(RECENTS_KEY).filter(
		(value) => !matchesLibraryRef(value, type, id)
	);
	const next = [{ type, id, ts: now }, ...without].slice(0, RECENTS_LIMIT);
	persistRecents(next);
}

/**
 * Stamp recents from a tab path opened anywhere in the app (the sidebar, the
 * command palette, the Library itself). Maps the deep-linkable routes back to a
 * `{type,id}` ref so "recently visited" reflects real navigation, not just
 * Library clicks. Routes without an id in the path (Spaces) and id-less
 * destinations (Teams open a dialog, not a route) are stamped by their own
 * call sites instead. New-item routes (`/agents/new/edit`, `/workflows/new`)
 * and id-less new chats carry no real item, so they're skipped.
 */
export function stampRecentFromPath(
	path: string,
	conversationId?: string
): void {
	const base = path.split("?")[0];
	if (base === "/chat") {
		if (conversationId) {
			stampRecent("chat", conversationId);
		}
		return;
	}
	const segments = base.split("/").filter(Boolean);
	// /agents/:id/edit
	if (segments[0] === "agents" && segments[1] && segments[1] !== "new") {
		stampRecent("agent", segments[1]);
		return;
	}
	// /workflows/:id
	if (segments[0] === "workflows" && segments[1] && segments[1] !== "new") {
		stampRecent("workflow", segments[1]);
		return;
	}
	// /meetings/:id
	if (segments[0] === "meetings" && segments[1]) {
		stampRecent("meeting", segments[1]);
		return;
	}
	// /channels/:id (skip "new")
	if (segments[0] === "channels" && segments[1] && segments[1] !== "new") {
		stampRecent("channel", segments[1]);
		return;
	}
	// /identities/profile/:profileId
	if (
		segments[0] === "identities" &&
		segments[1] === "profile" &&
		segments[2]
	) {
		try {
			stampRecent("identity", decodeURIComponent(segments[2]));
		} catch {
			stampRecent("identity", segments[2]);
		}
	}
}

// --- React subscriptions --------------------------------------------------

/**
 * Subscribe to the favorites list. Returns the current refs plus a toggle that
 * routes through {@link toggleFavorite}. Stays in sync across surfaces via the
 * change event (same tab) and the `storage` event (other windows).
 */
export function useFavorites() {
	const [favorites, setFavorites] = useState<LibraryRef[]>(loadFavorites);

	useEffect(() => {
		const resync = () => setFavorites(loadFavorites());
		window.addEventListener(FAVORITES_CHANGED_EVENT, resync);
		window.addEventListener("storage", resync);
		return () => {
			window.removeEventListener(FAVORITES_CHANGED_EVENT, resync);
			window.removeEventListener("storage", resync);
		};
	}, []);

	return {
		favorites,
		toggle: (type: LibraryItemType, id: string) => {
			toggleFavorite(type, id);
			// Optimistic local update; the event listener reconciles right after.
			setFavorites(loadFavorites());
		},
	};
}

/** Subscribe to the recents list (most-recent first). */
export function useRecents(): RecentEntry[] {
	const [recents, setRecents] = useState<RecentEntry[]>(loadRecents);

	useEffect(() => {
		const resync = () => setRecents(loadRecents());
		window.addEventListener(RECENTS_CHANGED_EVENT, resync);
		window.addEventListener("storage", resync);
		return () => {
			window.removeEventListener(RECENTS_CHANGED_EVENT, resync);
			window.removeEventListener("storage", resync);
		};
	}, []);

	return recents;
}
