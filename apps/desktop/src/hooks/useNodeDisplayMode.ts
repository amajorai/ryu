import { useEffect, useState } from "react";
import { announceLocalStorageChange } from "@/src/lib/same-document-storage-event.ts";

export type NodeDisplayMode = "compact-dropdown" | "persistent-sidebar";

const KEY_DISPLAY_MODE = "ryu_node_display_mode";
const KEY_TAB_OVERRIDE = "ryu_node_tab_override_enabled";

function readNodeDisplayMode(): NodeDisplayMode {
	return localStorage.getItem(KEY_DISPLAY_MODE) === "persistent-sidebar"
		? "persistent-sidebar"
		: "compact-dropdown";
}

export function useNodeDisplayMode(): NodeDisplayMode {
	const [mode, setMode] = useState<NodeDisplayMode>(readNodeDisplayMode);

	useEffect(() => {
		const handler = () => {
			setMode(readNodeDisplayMode());
		};
		window.addEventListener("storage", handler);
		return () => window.removeEventListener("storage", handler);
	}, []);

	return mode;
}

export function setNodeDisplayMode(mode: NodeDisplayMode) {
	localStorage.setItem(KEY_DISPLAY_MODE, mode);
	announceLocalStorageChange(KEY_DISPLAY_MODE);
}

export function useNodeTabOverride(): boolean {
	const [enabled, setEnabled] = useState(() => {
		const stored = localStorage.getItem(KEY_TAB_OVERRIDE);
		return stored === null ? true : stored === "true";
	});

	useEffect(() => {
		const handler = () => {
			const stored = localStorage.getItem(KEY_TAB_OVERRIDE);
			setEnabled(stored === null ? true : stored === "true");
		};
		window.addEventListener("storage", handler);
		return () => window.removeEventListener("storage", handler);
	}, []);

	return enabled;
}

export function setNodeTabOverride(enabled: boolean) {
	localStorage.setItem(KEY_TAB_OVERRIDE, String(enabled));
	announceLocalStorageChange(KEY_TAB_OVERRIDE);
}
