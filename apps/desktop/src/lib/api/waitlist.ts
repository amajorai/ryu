// Desktop client for the waitlist control plane (packages/api routers/waitlist.ts).
// Talks to the control-plane server (BACKEND_URL, :3000) with the stored Better
// Auth bearer token — the same auth the rest of the desktop control-plane calls
// use. This is what gates desktop activation: an account that is still "pending"
// sees the waitlist screen instead of the app.
//
// On the webapp (app.ryuhq.com) a signed-in user can legitimately have NO bearer
// in localStorage: the device flow's `returnTo` redirect (LoginPage.tsx sends it,
// apps/web device/approve navigates to it) lands in a fresh browsing context that
// never ran the poll that persists the token, while the cross-subdomain Better
// Auth cookie already authenticates them. Bailing out here without asking the
// server produced an unresolvable null, which App.tsx's fail-closed gate reads as
// "pending" — an approved account stuck on the waitlist screen. So fall back to
// cookie auth (`credentials: "include"`, what packages/settings api-client uses)
// and let the server decide.

import {
	fetchWaitlistMe as fetchWaitlistMeAtTarget,
	openWaitlistStream as openWaitlistStreamAtTarget,
	type WaitlistClientTarget,
	type WaitlistMe,
	type WaitlistStatusEvent,
} from "@ryuhq/core-client/waitlist.ts";
import type { SseMessage } from "@ryuhq/protocol/sse";
import { BACKEND_URL, getActiveToken } from "@/lib/auth-client.ts";

export type { WaitlistMe, WaitlistStatusEvent };

function authToken(): string | null {
	try {
		return getActiveToken();
	} catch {
		return null;
	}
}

function target(): WaitlistClientTarget {
	return { token: authToken(), url: BACKEND_URL };
}

/** Open the caller's approval stream with bearer and cookie auth support. */
export function openWaitlistStream(
	signal: AbortSignal
): AsyncGenerator<SseMessage<WaitlistStatusEvent>> {
	return openWaitlistStreamAtTarget(target(), signal);
}

/** The signed-in user's own waitlist state, or null when it can't be resolved. */
export async function fetchWaitlistMe(): Promise<WaitlistMe | null> {
	return fetchWaitlistMeAtTarget(target());
}

/**
 * Give the reserved handle back. Mirrors the web client's
 * `releaseWaitlistUsername` — the same route, the same fire-and-forget shape —
 * so "Change handle" on the desktop can actually release rather than only
 * offering to overwrite.
 */
export async function releaseWaitlistUsername(): Promise<void> {
	const token = getActiveToken();
	const resp = await fetch(`${BACKEND_URL}/api/waitlist/username/release`, {
		method: "POST",
		credentials: "include",
		headers: token ? { Authorization: `Bearer ${token}` } : undefined,
	});
	if (!resp.ok) {
		throw new Error(`Failed to release handle (${resp.status})`);
	}
}
