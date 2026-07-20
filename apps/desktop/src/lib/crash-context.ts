// apps/desktop/src/lib/crash-context.ts
//
// A tiny module singleton that records the user's current in-app location so the
// dev-only "Copy console" action on the crash screen (CrashBoundary.tsx) can
// include it for context. The desktop app routes between pages through the tabs
// context under a MemoryRouter, so `window.location` never reflects the real page
// — the active tab's `path`/`title` is the meaningful "route". CrashBoundary lives
// OUTSIDE the TabsProvider (it wraps the whole app), so it can't read that context
// directly; this singleton bridges the two, mirroring the console-buffer.ts pattern.

interface CrashRoute {
	path: string;
	title: string;
}

let currentRoute: CrashRoute | null = null;

/** Record the currently focused tab's route. Called by the layout on tab change. */
export const setCrashRoute = (route: CrashRoute | null): void => {
	currentRoute = route;
};

/** The last-focused tab's route, or null before any tab is focused. */
export const getCrashRoute = (): CrashRoute | null => currentRoute;
