import { lazy } from "react";

// Every screen past the login page loads on demand, so the first paint (the
// boot splash, then LoginPage) does not parse the signed-in shell, the chat and
// its markdown/diagram/chart stack, onboarding, or the overlay windows.
const loadSignedInShell = () => import("./SignedInShell.tsx");
const loadLayout = () => import("../components/layout/Layout.tsx");

/**
 * Keeps a screen's import pending while the browser build reloads for a new
 * deploy (apps/webapp/src/stale-chunk-reload.ts). Vite resolves an import whose
 * `vite:preloadError` was cancelled to `undefined`; React.lazy would throw on
 * it, so the crash boundary would flash and file a report for a page that is
 * about to reload. Pending, the Suspense fallback stays up until it unloads.
 * Every other failure still rejects. The desktop build never cancels the event,
 * so there it changes nothing.
 */
export function keepPendingWhileReloading<T>(
	load: () => Promise<T>
): () => Promise<T> {
	return () =>
		load().then((module: T | undefined) =>
			module === undefined ? new Promise<T>(() => undefined) : module
		);
}

export const SignedInShell = lazy(keepPendingWhileReloading(loadSignedInShell));
export const Layout = lazy(keepPendingWhileReloading(loadLayout));
export const OnboardingRoute = lazy(
	keepPendingWhileReloading(() => import("./OnboardingRoute.tsx"))
);
export const WaitlistPage = lazy(
	keepPendingWhileReloading(() => import("../pages/WaitlistPage.tsx"))
);
export const DesktopStartupChooser = lazy(() =>
	keepPendingWhileReloading(
		() => import("../components/startup/DesktopStartupChooser.tsx")
	)().then((module) => ({ default: module.DesktopStartupChooser }))
);
export const StandaloneAppEntry = lazy(
	keepPendingWhileReloading(() => import("../pages/StandaloneAppEntry.tsx"))
);
export const HostedStandaloneAppEntry = lazy(
	keepPendingWhileReloading(
		() => import("../pages/HostedStandaloneAppEntry.tsx")
	)
);
export const BotManagedEntry = lazy(() =>
	keepPendingWhileReloading(
		() => import("../components/bot/BotManagedEntry.tsx")
	)().then((module) => ({ default: module.BotManagedEntry }))
);
export const CompanionOverlay = lazy(
	keepPendingWhileReloading(() => import("./CompanionOverlay.tsx"))
);
export const MediaPipOverlay = lazy(
	keepPendingWhileReloading(() => import("./MediaPipOverlay.tsx"))
);
export const DesktopNativeSync = lazy(
	keepPendingWhileReloading(() => import("./DesktopNativeSync.tsx"))
);

/** A signed-in user is headed for the shell: fetch it alongside the remaining
 *  startup checks instead of after them. `layout` is false for the entries that
 *  never render the workspace Layout (Bot, standalone apps). A failed prefetch
 *  is ignored; the render-time load surfaces its own failure to the crash
 *  boundary. */
export function preloadSignedInShell({ layout }: { layout: boolean }): void {
	loadSignedInShell().catch(() => undefined);
	if (layout) {
		loadLayout().catch(() => undefined);
	}
}
