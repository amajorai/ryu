import { Logo as OrbLogo } from "@ryu/ui/components/logo";
import { Toaster, toast } from "@ryu/ui/components/sileo";
import { listen } from "@tauri-apps/api/event";
import { ThemeProvider } from "next-themes";
import { useEffect, useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "@/contexts/auth-context.tsx";
import {
	authClient,
	BACKEND_URL,
	clearSessionToken,
	TOKEN_KEY,
	useSession,
	vaultHydrated,
} from "@/lib/auth-client.ts";
import {
	markLocalNudgeShown,
	preferLocalOrCloud,
	shouldNudgeLocalMissing,
} from "@/lib/prefer-local-node.ts";
import { getRyuStatus, startRyuCore } from "@/lib/tauri-bridge.ts";
import { EntitlementProvider } from "@/src/contexts/entitlement-context.tsx";
import { initAnalytics } from "@/src/lib/analytics.ts";
import { fetchWaitlistMe } from "@/src/lib/api/waitlist.ts";
import { initCrashReporting } from "@/src/lib/crash.ts";
import { AgentationToolbar } from "./components/AgentationToolbar.tsx";
import { CrashBoundary } from "./components/CrashBoundary.tsx";
import Layout from "./components/layout/Layout.tsx";
import { PageWrapper } from "./components/layout/PageWrapper.tsx";
import { initBackgroundCustomization } from "./hooks/useBackgroundCustomization.ts";
import { initChromeShadows } from "./hooks/useChromeShadows.ts";
import { initDialogOverlayBlur } from "./hooks/useDialogOverlayBlur.ts";
import { initPointerCursor } from "./hooks/usePointerCursor.ts";
import { initTheme, useThemePreset } from "./hooks/useThemePreset.ts";
import CompanionPage from "./pages/CompanionPage.tsx";
import LoginPage from "./pages/LoginPage.tsx";
import OnboardingPage from "./pages/OnboardingPage.tsx";
import { PreflightPage } from "./pages/PreflightPage.tsx";
import WaitlistPage from "./pages/WaitlistPage.tsx";
import { useAppStore } from "./store/useAppStore.ts";
import { useNodeStore } from "./store/useNodeStore.ts";

// Detect the Tauri window label synchronously via the internals object that
// Tauri injects before any JS runs. Falls back to "main" in a plain browser.
function getTauriWindowLabel(): string {
	try {
		// biome-ignore lint/suspicious/noExplicitAny: Tauri internal
		const internals = (window as any).__TAURI_INTERNALS__;
		return internals?.metadata?.currentWindow?.label ?? "main";
	} catch {
		return "main";
	}
}

const WINDOW_LABEL = getTauriWindowLabel();

// Remembers the last server-confirmed "approved" so a transient control-plane
// outage doesn't lock an already-approved user out of the app. Cleared on a
// definite "pending" and on sign-out.
const WAITLIST_APPROVED_KEY = "ryu_waitlist_approved";

export default function App() {
	// Companion overlay is a completely separate surface — no auth, no layout.
	// Wrap both surfaces in the crash boundary so an unhandled render error is
	// caught (recoverable fallback, not a white screen) and reported when the user
	// consented to crash reports.
	return (
		<CrashBoundary>
			{WINDOW_LABEL === "companion" ? <CompanionOverlay /> : <MainApp />}
		</CrashBoundary>
	);
}

function CompanionOverlay() {
	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="light"
			enableSystem
			themes={["light", "dark", "system"]}
		>
			<Toaster position="bottom-right" theme="system" />
			<CompanionPage />
		</ThemeProvider>
	);
}

function ThemeWatcher() {
	useThemePreset();
	return null;
}

function MainApp() {
	const setCoreStatus = useAppStore((state) => state.setCoreStatus);
	const coreStatus = useAppStore((state) => state.coreStatus);
	const initNodes = useNodeStore((s) => s.init);
	const { data: session, isPending } = useSession();
	const pendingAuthToken = useAppStore((s) => s.pendingAuthToken);
	const setPendingAuthToken = useAppStore((s) => s.setPendingAuthToken);
	const isAuthenticated = useAppStore((s) => s.isAuthenticated);
	const setIsAuthenticated = useAppStore((s) => s.setIsAuthenticated);
	const setOidcUser = useAppStore((s) => s.setOidcUser);

	// `useSession()` (Better Auth) re-fetches on every window focus, flipping
	// `isPending` back to true. Without this guard that swaps the whole tree to
	// the loading spinner and REMOUNTS LoginPage — so alt-tabbing back from the
	// device-approval tab reset the sign-in flow to "Get Started" and killed the
	// poll. Show the full-screen spinner only until the session resolves the FIRST
	// time; later focus-refetches keep the current screen mounted.
	const [sessionSettledOnce, setSessionSettledOnce] = useState(false);
	useEffect(() => {
		if (!isPending) {
			setSessionSettledOnce(true);
		}
	}, [isPending]);

	useEffect(() => {
		// Initialize product analytics once. Gated: a no-op unless a PostHog key is
		// configured AND the opt-out (seeded synchronously from the localStorage
		// mirror of `product-analytics-enabled`) is on. The Privacy tab seeds the
		// live gate from Core's canonical pref when opened.
		initAnalytics();
		// Initialize the crash reporting tier (SEPARATE consent from analytics).
		// Gated: a no-op unless a Sentry DSN is configured AND the opt-out (seeded
		// from the localStorage mirror of `crash-reports-enabled`) is on. The
		// Privacy tab seeds the live gate from Core's canonical pref when opened.
		initCrashReporting();
		let unlisten: (() => void) | undefined;
		initNodes().then((fn) => {
			unlisten = fn;
		});
		return () => {
			unlisten?.();
		};
	}, [initNodes]);

	useEffect(() => {
		let cancelled = false;

		async function init() {
			// Attempt to spawn Core — ignore errors (may already be running).
			await startRyuCore().catch(() => undefined);

			// Poll until HTTP health check passes (covers already-running instances).
			// Timeout is long to accommodate first-time Rust compilation in dev.
			const POLL_INTERVAL_MS = 1500;
			const TIMEOUT_MS = 180_000;
			const start = Date.now();

			while (!cancelled) {
				const status = await getRyuStatus().catch(() => "stopped");
				if (status === "running") {
					if (!cancelled) {
						setCoreStatus("running");
					}
					return;
				}
				if (Date.now() - start > TIMEOUT_MS) {
					if (!cancelled) {
						setCoreStatus("stopped");
					}
					return;
				}
				await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
			}
		}

		init();
		return () => {
			cancelled = true;
		};
	}, [setCoreStatus]);

	useEffect(() => {
		// Surface ryu-core auto-install progress emitted by the Rust setup hook when
		// a fresh production install downloads the binary from the release hub. A
		// no-op in dev (turbo owns the binary, so the backend never emits these).
		let unlisten: (() => void) | undefined;
		listen<{ phase: string; error?: string }>(
			"core-install-progress",
			({ payload }) => {
				if (payload.phase === "downloading") {
					toast.info("Downloading Ryu Core…");
				} else if (payload.phase === "done") {
					toast.success("Ryu Core installed");
				} else if (payload.phase === "error") {
					toast.error(payload.error ?? "Couldn't install Ryu Core");
				}
			}
		).then((fn) => {
			unlisten = fn;
		});
		return () => {
			unlisten?.();
		};
	}, []);

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
			const token = localStorage.getItem(TOKEN_KEY);
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
				if (res.ok) {
					const data = (await res.json()) as { user?: { id?: string } };
					if (data.user?.id) {
						setIsAuthenticated(true);
						return;
					}
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
		const token = localStorage.getItem(TOKEN_KEY);
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

	// Waitlist activation gate. Once authenticated, ask the control plane whether
	// this account is off the waitlist. Pending accounts see WaitlistPage instead
	// of the app.
	//
	// Fail-CLOSED: the user enters the app ONLY when the server explicitly says
	// "approved". A pending status, an unreachable control plane, or no token all
	// keep the gate up — otherwise the gate is trivially bypassable. To avoid
	// locking out a genuinely-approved user during a transient outage, the last
	// confirmed "approved" is cached; an unresolved check falls back to that cache
	// (but a definite "pending" clears it). The 20s poll lets a fresh approval —
	// or a recovered server — through without a restart.
	const authed = !!session || isAuthenticated;
	const [waitlistGate, setWaitlistGate] = useState<
		"loading" | "approved" | "pending"
	>("loading");

	useEffect(() => {
		if (!authed) {
			setWaitlistGate("loading");
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
		const check = async () => {
			let me: Awaited<ReturnType<typeof fetchWaitlistMe>> = null;
			try {
				me = await fetchWaitlistMe();
			} catch {
				me = null;
			}
			if (!active) {
				return;
			}
			if (me?.status === "approved") {
				localStorage.setItem(WAITLIST_APPROVED_KEY, "1");
				setWaitlistGate("approved");
				stop();
			} else if (me?.status === "pending") {
				localStorage.removeItem(WAITLIST_APPROVED_KEY);
				setWaitlistGate("pending");
			} else if (localStorage.getItem(WAITLIST_APPROVED_KEY) === "1") {
				// Couldn't resolve, but this account was confirmed approved before —
				// don't lock them out over a transient failure.
				setWaitlistGate("approved");
			} else {
				// Unknown: distinguish dead credentials (→ re-login) from a transient
				// outage. Probe with whatever we have — the webapp is often cookie-only
				// (no bearer after the device flow's returnTo redirect), so requiring a
				// stored token here skipped the probe and fell straight through to
				// pending.
				const token = localStorage.getItem(TOKEN_KEY);
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
					const dead =
						res.status === 401 ||
						res.status === 403 ||
						(res.ok &&
							!(
								(await res.json().catch(() => null)) as {
									user?: unknown;
								} | null
							)?.user);
					if (!active) {
						return;
					}
					if (dead) {
						await clearSessionToken();
						setIsAuthenticated(false);
						setWaitlistGate("loading");
						return;
					}
				} catch {
					// Network blip — fall through to fail-closed pending below.
				}
				// Unknown + never confirmed → stay gated (fail closed).
				setWaitlistGate("pending");
			}
		};
		check();
		timer = setInterval(check, 20_000);
		return () => {
			active = false;
			stop();
		};
	}, [authed, setIsAuthenticated]);

	useEffect(() => {
		initTheme();
		initPointerCursor();
		initChromeShadows();
		initDialogOverlayBlur();
		initBackgroundCustomization();
	}, []);

	useEffect(() => {
		const fix = () => {
			const container = document.querySelector(
				"[data-tauri-decorum-tb]"
			) as HTMLElement | null;
			const dragRegion = document.querySelector(
				"[data-tauri-decorum-tb] [data-tauri-drag-region]"
			) as HTMLElement | null;
			if (dragRegion) {
				dragRegion.remove();
			}
			if (container) {
				container.style.setProperty("top", "16px", "important");
				container.style.setProperty("right", "12px", "important");
				container.style.setProperty("left", "auto", "important");
				container.style.setProperty("width", "auto", "important");
				container.style.setProperty("pointer-events", "none", "important");
				for (const btn of container.querySelectorAll<HTMLElement>(
					"button, .decorum-tb-btn"
				)) {
					btn.style.setProperty("pointer-events", "auto", "important");
				}
			}
		};
		// tauri-plugin-decorum re-asserts its native titlebar (full width, with its
		// own drag region) on window events — focus, maximize/restore, resize. The
		// old fix only ran on a 5s interval, so any revert AFTER that window left a
		// full-width decorum bar covering the app's titlebar with the drag region
		// already stripped — making the titlebar undraggable AND the tabs unclickable.
		// Re-assert the fix permanently: an observer (disconnected during our own
		// writes so they don't re-trigger it) plus the same window events decorum
		// reacts to. No teardown timeout — it must outlive the 5s window.
		const observeOpts: MutationObserverInit = {
			attributes: true,
			attributeFilter: ["style", "class"],
			childList: true,
			subtree: true,
		};
		// Debounced via rAF so a burst of unrelated DOM mutations (e.g. a streaming
		// chat) coalesces into a single fix per frame. Disconnect around our own
		// writes so they never re-trigger the observer into a loop.
		let scheduled = false;
		const run = () => {
			scheduled = false;
			observer.disconnect();
			fix();
			observer.observe(document.documentElement, observeOpts);
		};
		const observer = new MutationObserver(() => {
			if (scheduled) {
				return;
			}
			scheduled = true;
			requestAnimationFrame(run);
		});
		fix();
		observer.observe(document.documentElement, observeOpts);
		window.addEventListener("focus", fix);
		window.addEventListener("resize", fix);
		return () => {
			observer.disconnect();
			window.removeEventListener("focus", fix);
			window.removeEventListener("resize", fix);
		};
	}, []);

	const showApp = authed;
	// Hold the app behind the waitlist check while it resolves, so we never flash
	// the app and then bounce a pending user to the queue screen.
	const waitlistResolving = showApp && waitlistGate === "loading";
	const waitlisted = showApp && waitlistGate === "pending";

	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="light"
			enableSystem
			themes={["light", "dark", "system"]}
		>
			<ThemeWatcher />
			<Toaster position="bottom-right" theme="system" />
			<AgentationToolbar />
			{coreStatus === "stopped" ? (
				<PageWrapper>
					<PreflightPage />
				</PageWrapper>
			) : (isPending && !sessionSettledOnce) || waitlistResolving ? (
				<PageWrapper>
					<div
						className="flex h-full w-full items-center justify-center"
						data-tauri-drag-region
					>
						<OrbLogo size="56px" variant="shimmer" />
					</div>
				</PageWrapper>
			) : waitlisted ? (
				<PageWrapper>
					<WaitlistPage userName={session?.user?.name ?? null} />
				</PageWrapper>
			) : showApp ? (
				<AuthProvider>
					<PageWrapper>
						<EntitlementProvider>
							<MemoryRouter
								initialEntries={[
									localStorage.getItem("ryu_onboarding_complete") === "true"
										? "/chat"
										: "/onboarding",
								]}
							>
								<Routes>
									<Route element={<OnboardingPage />} path="/onboarding" />
									<Route element={<Layout />} path="/*" />
								</Routes>
							</MemoryRouter>
						</EntitlementProvider>
					</PageWrapper>
				</AuthProvider>
			) : (
				<PageWrapper>
					<LoginPage />
				</PageWrapper>
			)}
		</ThemeProvider>
	);
}
