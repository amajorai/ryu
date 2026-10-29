import { toast } from "@ryu/ui/components/sileo.tsx";
import { useEffect } from "react";
import { z } from "zod";
import {
	authClient,
	BACKEND_URL,
	clearSessionToken,
	getActiveToken,
	vaultHydrated,
} from "@/lib/auth-client.ts";
import {
	markLocalNudgeShown,
	preferLocalOrCloud,
	shouldNudgeLocalMissing,
} from "@/lib/prefer-local-node.ts";
import { useAppStore } from "../store/useAppStore.ts";
import type { SessionData } from "./session-data.ts";

/** Keeps the signed-in state honest: adopts a freshly stored bearer, drops a
 *  dead one after the vault hydrates, picks the webapp's node, and fills the
 *  profile for a bearer-only session. */
export function useSessionValidation(session: SessionData): void {
	const pendingAuthToken = useAppStore((s) => s.pendingAuthToken);
	const setPendingAuthToken = useAppStore((s) => s.setPendingAuthToken);
	const isAuthenticated = useAppStore((s) => s.isAuthenticated);
	const setIsAuthenticated = useAppStore((s) => s.setIsAuthenticated);
	const setOidcUser = useAppStore((s) => s.setOidcUser);

	useEffect(() => {
		if (!pendingAuthToken) {
			return;
		}
		setIsAuthenticated(true);
		setPendingAuthToken(null);
		// Force the Better Auth session cache to re-fetch now the bearer token is stored.
		authClient.getSession().catch(() => undefined);
	}, [pendingAuthToken, setPendingAuthToken, setIsAuthenticated]);

	// After the vault hydrates from disk, only treat the user as signed in when
	// the bearer token still resolves to a live session. A stale/expired token
	// used to leave `isAuthenticated` true (token presence only) and trap
	// approved users on the waitlist gate when `/api/waitlist/me` returned 401.
	useEffect(() => {
		let cancelled = false;
		vaultHydrated.then(async () => {
			if (cancelled || pendingAuthToken) {
				return;
			}
			const token = getActiveToken();
			if (!token) {
				return;
			}
			try {
				const res = await fetch(`${BACKEND_URL}/api/auth/get-session`, {
					headers: { Authorization: `Bearer ${token}` },
				});
				if (cancelled) {
					return;
				}
				// get-session answers 200 with a null body for dead credentials, so
				// only that or a 401/403 clears the token. A 5xx/429 (a redeploy or a
				// proxy hiccup) says nothing about the session: keep the token.
				const decoded = z
					.object({
						user: z.object({ id: z.string().optional() }).optional(),
					})
					.nullable()
					.safeParse(res.ok ? await res.json().catch(() => null) : null);
				if (cancelled) {
					return;
				}
				const data = decoded.success ? decoded.data : null;
				if (data?.user?.id) {
					setIsAuthenticated(true);
					return;
				}
				const dead = res.status === 401 || res.status === 403 || res.ok;
				if (!dead) {
					return;
				}
				await clearSessionToken();
				if (!cancelled) {
					setIsAuthenticated(false);
				}
			} catch {
				// Offline on launch — leave the token; the waitlist gate can use cache.
			}
		});
		return () => {
			cancelled = true;
		};
	}, [pendingAuthToken, setIsAuthenticated]);

	// Webapp returning visits: silently prefer local when reachable, else cloud
	// (nudge once per tab if local is missing). Fresh sign-in nudges from LoginPage.
	useEffect(() => {
		if (import.meta.env.VITE_RYU_SURFACE !== "webapp") {
			return;
		}
		if (!(isAuthenticated || session)) {
			return;
		}
		let cancelled = false;
		preferLocalOrCloud().then((pick) => {
			if (cancelled || pick !== "cloud" || !shouldNudgeLocalMissing()) {
				return;
			}
			markLocalNudgeShown();
			toast.info("No local node detected", {
				description:
					"Using Ryu Cloud for now. Open the node selector to connect a local or remote node.",
			});
		});
		return () => {
			cancelled = true;
		};
	}, [isAuthenticated, session]);

	// Fetch user profile when useSession() returns null but we have a bearer token.
	// Uses get-session (bearer plugin) rather than oauth2/userinfo (expects a JWT).
	useEffect(() => {
		if (!isAuthenticated || session) {
			return;
		}
		const token = getActiveToken();
		if (!token) {
			return;
		}
		fetch(`${BACKEND_URL}/api/auth/get-session`, {
			headers: { Authorization: `Bearer ${token}` },
		})
			.then((r) => (r.ok ? r.json() : null))
			.then((data) => {
				const u = data?.user;
				if (u) {
					setOidcUser({
						name: u.name ?? null,
						email: u.email ?? null,
						picture: u.image ?? null,
					});
				}
			})
			.catch(() => undefined);
	}, [isAuthenticated, session, setOidcUser]);
}
