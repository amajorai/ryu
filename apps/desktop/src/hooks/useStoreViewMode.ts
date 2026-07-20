import type { ViewMode } from "@ryu/blocks/desktop/view-toggle";
import { useEffect, useState } from "react";

// Persisted grid/list preference for the Store catalog sections (Engines,
// Agents). One shared key so the choice is consistent across both tabs and
// survives reloads. Mirrors useNodeDisplayMode: a `storage` event keeps every
// mounted instance in sync within the same window.

const KEY = "ryu:store-view-mode";
const DEFAULT_MODE: ViewMode = "grid";

function read(): ViewMode {
	const stored = localStorage.getItem(KEY);
	return stored === "list" || stored === "grid" ? stored : DEFAULT_MODE;
}

export function useStoreViewMode(): [ViewMode, (mode: ViewMode) => void] {
	const [mode, setMode] = useState<ViewMode>(read);

	useEffect(() => {
		const handler = () => setMode(read());
		window.addEventListener("storage", handler);
		return () => window.removeEventListener("storage", handler);
	}, []);

	const set = (next: ViewMode) => {
		localStorage.setItem(KEY, next);
		window.dispatchEvent(new Event("storage"));
	};

	return [mode, set];
}
