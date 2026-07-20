import { useEffect, useState } from "react";

/** What the main window opens on when the app launches — a Chrome-style
    "On startup" preference:
      - `empty`   → no tabs; the launchpad / empty-tabs home (the default)
      - `home`    → a single Home tab
      - `chat`    → a single fresh chat tab
      - `restore` → reopen the tabs from the previous session (falls back to
                    `empty` when there is nothing to restore)
    Window-local + reactive across settings and the tabs provider via the same
    localStorage + `storage`-event pattern as the other desktop UI prefs
    (see `useTabLayout`). */
export type StartupBehavior = "empty" | "home" | "chat" | "restore";

const KEY = "ryu_startup_behavior";

const VALUES: StartupBehavior[] = ["empty", "home", "chat", "restore"];

function isStartupBehavior(value: string | null): value is StartupBehavior {
	return value !== null && (VALUES as string[]).includes(value);
}

/** The persisted startup behavior, defaulting to `empty` — a clean, no-tabs
    launchpad when the window opens. */
export function readStartupBehavior(): StartupBehavior {
	const stored = localStorage.getItem(KEY);
	return isStartupBehavior(stored) ? stored : "empty";
}

export function useStartupBehavior(): StartupBehavior {
	const [behavior, setBehavior] =
		useState<StartupBehavior>(readStartupBehavior);

	useEffect(() => {
		const handler = () => setBehavior(readStartupBehavior());
		window.addEventListener("storage", handler);
		return () => window.removeEventListener("storage", handler);
	}, []);

	return behavior;
}

export function setStartupBehavior(behavior: StartupBehavior) {
	localStorage.setItem(KEY, behavior);
	// Same-document listeners don't get the native `storage` event, so broadcast
	// one ourselves — every useStartupBehavior() consumer re-reads on this.
	window.dispatchEvent(new Event("storage"));
}
