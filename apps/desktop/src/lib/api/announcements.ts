// apps/desktop/src/lib/api/announcements.ts
//
// Typed client for product announcements (packages/api `/api/announcements`).
// Like credits.ts / channels.ts (and unlike the Core-node clients), this targets
// the identity/control-plane server (:3000, BACKEND_URL), authenticated with the
// Better-Auth session bearer token. Announcements are admin-authored and global;
// each user's read/dismiss state is stored server-side (per-user), so it syncs
// across their devices.
//
//   GET  /api/announcements          -> the caller's feed (active, un-dismissed)
//   POST /api/announcements/:id/read    -> mark one read
//   POST /api/announcements/:id/dismiss -> hide one from the feed for good

import { BACKEND_URL, TOKEN_KEY } from "@/lib/auth-client.ts";

/** One announcement in the caller's feed (mirrors the server UserAnnouncementView). */
export interface Announcement {
	body: string | null;
	color: string | null;
	createdAt: string | null;
	icon: string | null;
	id: string;
	linkLabel: string | null;
	linkUrl: string | null;
	/** True once this user has marked it read (or opened its link). */
	read: boolean;
	title: string;
}

/** The Better-Auth session bearer token, or null when signed out / no storage. */
function authToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		// No storage — treated as signed out.
		return null;
	}
}

/** True when the user has a session token; the feed requires sign-in. */
export function hasAnnouncementsAuth(): boolean {
	return Boolean(authToken());
}

function authHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	const token = authToken();
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

const BASE = `${BACKEND_URL.replace(/\/$/, "")}/api/announcements`;

/** Fetch the caller's announcement feed (active, un-dismissed, newest first). */
export async function fetchAnnouncements(): Promise<Announcement[]> {
	const resp = await fetch(BASE, { headers: authHeaders() });
	if (!resp.ok) {
		throw new Error(`Failed to load announcements: ${resp.status}`);
	}
	const json = (await resp.json()) as { announcements: Announcement[] };
	return json.announcements ?? [];
}

/** Mark an announcement read for the caller. */
export async function markAnnouncementRead(id: string): Promise<void> {
	const resp = await fetch(`${BASE}/${id}/read`, {
		method: "POST",
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw new Error(`Failed to mark read: ${resp.status}`);
	}
}

/** Dismiss an announcement for the caller (hidden from the feed thereafter). */
export async function dismissAnnouncement(id: string): Promise<void> {
	const resp = await fetch(`${BASE}/${id}/dismiss`, {
		method: "POST",
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw new Error(`Failed to dismiss: ${resp.status}`);
	}
}
