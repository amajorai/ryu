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

import { BACKEND_URL, TOKEN_KEY } from "@/lib/auth-client.ts";

export interface WaitlistMe {
	applicationStatus: "submitted" | "approved" | "rejected" | null;
	// Rough wait estimate derived from position ("~3 weeks"), null when approved.
	eta: string | null;
	hasApplied: boolean;
	isAdmin: boolean;
	position: number | null;
	referralCode: string | null;
	referralCount: number;
	referralUrl: string | null;
	status: "pending" | "approved";
	totalWaiting: number;
}

/** The signed-in user's own waitlist state, or null when it can't be resolved. */
export async function fetchWaitlistMe(): Promise<WaitlistMe | null> {
	const token = localStorage.getItem(TOKEN_KEY);
	let resp: Response;
	try {
		resp = await fetch(`${BACKEND_URL}/api/waitlist/me`, {
			credentials: "include",
			headers: token ? { Authorization: `Bearer ${token}` } : undefined,
		});
	} catch {
		throw new Error("network");
	}
	if (resp.status === 401 || resp.status === 403) {
		return null;
	}
	if (!resp.ok) {
		throw new Error(`http-${resp.status}`);
	}
	return (await resp.json()) as WaitlistMe;
}
