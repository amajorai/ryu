// Standalone browser story for the REAL shared command palette
// (`@ryu/command/CommandPalette`) — the exact prop-driven surface the desktop's
// Cmd+K modal renders. Mounts it with a fixed `CommandAction[]` behind an open
// button so a Playwright spec can drive open → search (cmdk fuzzy filter) →
// select without Core, Tauri, or the desktop's context/provider tree.
//
// The Cmd+K *binding* itself lives in the desktop wrapper (useHotkey + contexts)
// and is out of scope here; this story certifies the shared component's own
// behavior (grouping, filtering, empty state, onSelect), which is what renders
// inside both the Tauri webview and the Electron command bar.

import { CommandPalette } from "@ryu/command/CommandPalette";
import type { CommandAction } from "@ryu/command/types";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

function Story() {
	const [open, setOpen] = useState(false);
	const [lastSelected, setLastSelected] = useState("");

	const select = (id: string) => () => {
		setLastSelected(id);
	};

	const actions: CommandAction[] = [
		{
			id: "settings",
			group: "Navigation",
			title: "Open Settings",
			value: "open settings",
			shortcut: "⌘,",
			onSelect: select("settings"),
		},
		{
			id: "marketplace",
			group: "Navigation",
			title: "Open Marketplace",
			value: "open marketplace",
			onSelect: select("marketplace"),
		},
		{
			id: "new-chat",
			group: "Chat",
			title: "New Chat",
			value: "new chat",
			shortcut: "⌘N",
			onSelect: select("new-chat"),
		},
		{
			id: "import",
			group: "Chat",
			title: "Import Threads",
			value: "import threads",
			onSelect: select("import"),
		},
		{
			id: "dark",
			group: "Appearance",
			title: "Dark Mode",
			value: "dark mode",
			checked: true,
			onSelect: select("dark"),
		},
	];

	return (
		<div style={{ padding: 40 }}>
			<button
				data-testid="open-palette"
				onClick={() => setOpen(true)}
				type="button"
			>
				Open command palette
			</button>
			<div data-testid="last-selected">{lastSelected}</div>
			<CommandPalette
				actions={actions}
				chrome="dialog"
				onOpenChange={setOpen}
				open={open}
			/>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
