// apps/desktop/src/hooks/useAutoImportThreads.ts
//
// One shared, persisted toggle for auto-importing agents' own on-disk threads
// (Claude Code / Codex) into Ryu conversations, the way VS Code auto-surfaces an
// agent's past threads. When ON, `useAutoThreadImport` periodically scans the
// history-supporting agents' native transcript stores and imports any thread not
// already imported, filing each under the workspace folder it ran in. Off by
// default — importing stays a manual action unless the user opts in. Backed by
// localStorage and broadcast through a tiny external store so the setting and the
// background poller stay in sync the instant either flips it.

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "ryu:auto-import-agent-threads";

const listeners = new Set<() => void>();

function read(): boolean {
	try {
		// Default OFF: only an explicit "true" enables background auto-import.
		return localStorage.getItem(STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	// Cross-window updates (e.g. a second desktop window) stay in sync too.
	const onStorage = (e: StorageEvent) => {
		if (e.key === STORAGE_KEY) {
			cb();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(cb);
		window.removeEventListener("storage", onStorage);
	};
}

/**
 * `[autoImport, setAutoImport]`. Persisted, default `false`, shared across
 * windows. Read the value non-reactively with `readAutoImportThreads()`.
 */
export function useAutoImportThreads(): [boolean, (v: boolean) => void] {
	const autoImport = useSyncExternalStore(subscribe, read, () => false);

	const setAutoImport = useCallback((v: boolean) => {
		try {
			localStorage.setItem(STORAGE_KEY, v ? "true" : "false");
		} catch {
			// Non-fatal: persistence is best-effort.
		}
		for (const cb of listeners) {
			cb();
		}
	}, []);

	return [autoImport, setAutoImport];
}

/** Non-reactive read of the current setting (e.g. inside effects/timers). */
export function readAutoImportThreads(): boolean {
	return read();
}
