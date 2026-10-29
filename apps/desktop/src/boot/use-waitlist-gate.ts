import { GUEST_MODE_ENABLED } from "@ryu/auth/lib/guest-mode";
import { readWaitlistManagedOnly } from "@ryuhq/core-client/waitlist.ts";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
	authClient,
	BACKEND_URL,
	clearSessionToken,
	getActiveToken,
} from "@/lib/auth-client.ts";
import { PLAYGROUND_BUILD } from "@/lib/playground.ts";
import { fetchWaitlistMe } from "@/src/lib/api/waitlist.ts";
import {
	nextWaitlistManagedOnly,
	resolveWaitlistSurface,
	type WaitlistGateState,
	type WaitlistGateStatus,
	waitlistApprovedKeyForUser,
	waitlistScopeForNode,
} from "../lib/waitlist-gate.ts";
import { useAppStore } from "../store/useAppStore.ts";
import type { Node } from "../store/useNodeStore.ts";
import type { SessionData } from "./session-data.ts";

// Remembers the last server-confirmed "approved" so a transient control-plane
// outage doesn't lock an already-approved user out of the app. Cleared on a
// definite "pending" and on sign-out.
const WAITLIST_APPROVED_KEY = "ryu_waitlist_approved";

/** This account's last confirmed waitlist approval, so a returning approved user
 *  gets the app shell on the first frame instead of waiting on two network checks.
 *  Anonymous sessions are never cached: their gate depends on GUEST_MODE_ENABLED. */
function readCachedWaitlistApproval(
	user: { id?: string; isAnonymous?: boolean | null } | undefined
): boolean {
	if (!user?.id || user.isAnonymous) {
		return false;
	}
	try {
		return localStorage.getItem(waitlistApprovedKeyForUser(user.id)) === "1";
	} catch {
		return false;
	}
}

// Waitlist scope is server-controlled; its current default gates every node.
// The server can narrow this to reachable managed nodes without a client build.
//
// For a node in the active scope, fail closed: the user enters only when the
// server explicitly says "approved". A pending status, an unreachable control plane,
// or no token all keep the gate up. To avoid locking out a genuinely-approved
// user during a transient outage, the last confirmed "approved" is cached; an
// unresolved check falls back to that cache (but a definite "pending" clears
// it). The 20s poll lets a fresh approval or a recovered server through without
// a restart. Local and connected non-managed nodes skip this hosted check.

/** Which surface the waitlist gate allows for the active node and account. */
export function useWaitlistGate({
	activeNodeForOnboarding,
	authed,
	session,
}: {
	activeNodeForOnboarding: Node;
	authed: boolean;
	session: SessionData;
}) {
	const setIsAuthenticated = useAppStore((s) => s.setIsAuthenticated);
	const [waitlistManagedOnly, setWaitlistManagedOnly] = useState<
		boolean | null
	>(null);
	const waitlistScope = waitlistScopeForNode(
		activeNodeForOnboarding,
		waitlistManagedOnly
	);
	const [waitlistGate, setWaitlistGate] = useState<WaitlistGateState>({
		scope: "all",
		status: "loading",
	});
	const disabledGuestCleanupStarted = useRef(false);
	// Start the account's waitlist read as soon as we are signed in, in parallel
	// with the managed-only scope flag it used to wait behind. The gate effect
	// consumes it on its first check; later checks fetch fresh.
	const earlyWaitlistMe = useRef<ReturnType<typeof fetchWaitlistMe> | null>(
		null
	);
	useEffect(() => {
		if (!authed || session?.user?.isAnonymous) {
			earlyWaitlistMe.current = null;
			return;
		}
		const early = fetchWaitlistMe();
		// Swallow here; the consumer handles failure when it awaits.
		early.catch(() => undefined);
		earlyWaitlistMe.current = early;
	}, [authed, session?.user?.isAnonymous]);

	useEffect(() => {
		let active = true;
		let controller: AbortController | null = null;
		const refresh = async () => {
			controller?.abort();
			const currentController = new AbortController();
			controller = currentController;
			const read = await readWaitlistManagedOnly(
				{ url: BACKEND_URL },
				currentController.signal
			);
			if (active && controller === currentController) {
				// A failed poll keeps the last known scope; flipping it would
				// unmount the app for a pending user on a local node.
				setWaitlistManagedOnly((previous) =>
					nextWaitlistManagedOnly(previous, read)
				);
			}
		};
		void refresh();
		const interval = setInterval(() => void refresh(), 20_000);
		return () => {
			active = false;
			controller?.abort();
			clearInterval(interval);
		};
	}, []);

	useEffect(() => {
		const setGateStatus = (status: WaitlistGateStatus) => {
			if (waitlistScope === "local") {
				setWaitlistGate({ scope: "local" });
				return;
			}
			if (waitlistScope === "loading") {
				setWaitlistGate({ scope: "all", status: "loading" });
				return;
			}
			setWaitlistGate({ scope: waitlistScope, status });
		};
		if (!authed) {
			setGateStatus("loading");
			return;
		}
		if (waitlistScope === "loading") {
			setGateStatus("loading");
			return;
		}
		if (waitlistScope === "local") {
			setGateStatus("approved");
			return;
		}
		let active = true;
		let timer: ReturnType<typeof setInterval> | null = null;
		const stop = () => {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		};
		const removeDisabledGuestSession = async () => {
			if (disabledGuestCleanupStarted.current) {
				return;
			}
			disabledGuestCleanupStarted.current = true;
			// Remove both the anonymous account and any browser credential. The reload
			// below also clears the cached client session used by the webapp shell.
			await authClient.deleteAnonymousUser().catch(() => undefined);
			await authClient.signOut().catch(() => undefined);
			await clearSessionToken();
			if (active) {
				setIsAuthenticated(false);
				window.location.reload();
			}
		};
		const check = async () => {
			if (session?.user?.isAnonymous) {
				if (!GUEST_MODE_ENABLED) {
					setGateStatus("loading");
					await removeDisabledGuestSession();
					return;
				}
				setGateStatus("approved");
				stop();
				return;
			}
			let me: Awaited<ReturnType<typeof fetchWaitlistMe>> = null;
			try {
				// Reuse the read started alongside the managed-only flag (see the
				// effect below) so the first check does not wait on two round trips.
				const early = earlyWaitlistMe.current;
				earlyWaitlistMe.current = null;
				me = await (early ?? fetchWaitlistMe());
			} catch {
				me = null;
			}
			if (!active) {
				return;
			}
			if (me?.status === "approved") {
				localStorage.setItem(WAITLIST_APPROVED_KEY, "1");
				if (session?.user?.id) {
					localStorage.setItem(
						waitlistApprovedKeyForUser(session.user.id),
						"1"
					);
				}
				setGateStatus("approved");
				stop();
			} else if (me?.status === "pending") {
				localStorage.removeItem(WAITLIST_APPROVED_KEY);
				if (session?.user?.id) {
					localStorage.removeItem(waitlistApprovedKeyForUser(session.user.id));
				}
				setGateStatus("pending");
			} else if (localStorage.getItem(WAITLIST_APPROVED_KEY) === "1") {
				// Couldn't resolve, but this account was confirmed approved before —
				// don't lock them out over a transient failure.
				setGateStatus("approved");
			} else {
				// Unknown: distinguish dead credentials (→ re-login) from a transient
				// outage. Probe with whatever we have — the webapp is often cookie-only
				// (no bearer after the device flow's returnTo redirect), so requiring a
				// stored token here skipped the probe and fell straight through to
				// pending.
				const token = getActiveToken();
				try {
					const res = await fetch(`${BACKEND_URL}/api/auth/get-session`, {
						credentials: "include",
						headers: token ? { Authorization: `Bearer ${token}` } : undefined,
					});
					if (!active) {
						return;
					}
					// get-session answers 200 with a null body when the credentials are
					// dead, so status alone can't tell "signed out" from "signed in" —
					// checking only the status left a stuck account looking healthy.
					const decoded = z
						.object({
							user: z
								.object({ isAnonymous: z.boolean().optional() })
								.optional(),
						})
						.nullable()
						.safeParse(res.ok ? await res.json().catch(() => null) : null);
					const data = decoded.success ? decoded.data : null;
					if (data?.user?.isAnonymous) {
						if (!GUEST_MODE_ENABLED) {
							setGateStatus("loading");
							await removeDisabledGuestSession();
							return;
						}
						setGateStatus("approved");
						stop();
						return;
					}
					const dead =
						res.status === 401 || res.status === 403 || (res.ok && !data?.user);
					if (!active) {
						return;
					}
					if (dead) {
						await clearSessionToken();
						setIsAuthenticated(false);
						setGateStatus("loading");
						return;
					}
				} catch {
					// Network blip — fall through to fail-closed pending below.
				}
				// Unknown + never confirmed → stay gated (fail closed).
				setGateStatus("pending");
			}
		};
		check();
		timer = setInterval(check, 20_000);
		return () => {
			active = false;
			stop();
		};
	}, [
		authed,
		session?.user?.id,
		session?.user?.isAnonymous,
		setIsAuthenticated,
		waitlistScope,
	]);

	return PLAYGROUND_BUILD
		? "app"
		: resolveWaitlistSurface({
				cachedApproved: readCachedWaitlistApproval(session?.user),
				managedOnly: waitlistManagedOnly,
				node: activeNodeForOnboarding,
				state: waitlistGate,
			});
}
