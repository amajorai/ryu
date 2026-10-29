import proofStyles from "./command-palette-story.module.css";
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

import { InputBar } from "@ryu/blocks/desktop/agent-elements/input-bar.tsx";
import { CommandPalette } from "@ryu/command/CommandPalette";
import type { CommandAction } from "@ryu/command/types";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

function Story() {
	const [open, setOpen] = useState(false);
	const [activeTab, setActiveTab] = useState("all");
	const [composeDraft, setComposeDraft] = useState("");
	const [lastSelected, setLastSelected] = useState("");

	const select = (id: string) => () => {
		setLastSelected(id);
	};

	const submitCompose = (content: string) => {
		setLastSelected(`compose:${content.trim()}`);
		setComposeDraft("");
		setOpen(false);
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
			resultType: "chats",
			shortcut: "⌘N",
			onSelect: select("new-chat"),
		},
		{
			id: "import",
			group: "Chat",
			title: "Import Threads",
			value: "import threads",
			resultType: "chats",
			onSelect: select("import"),
		},
		{
			id: "space-roadmap",
			group: "Spaces",
			title: "Product Roadmap",
			value: "space product roadmap",
			resultType: "spaces",
			onSelect: select("space-roadmap"),
		},
		{
			id: "canvas-launch",
			group: "Canvas",
			title: "Launch Canvas",
			value: "canvas launch",
			resultType: "plugin:com.ryu.canvas:boards",
			onSelect: select("canvas-launch"),
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
		<div className={proofStyles.fixture1}>
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
				activeTab={activeTab}
				chrome="dialog"
				composeContent={
					<InputBar
						autoFocus
						className="pt-2.5"
						leftActions={
							<span
								className="flex items-center gap-2 px-2 text-muted-foreground text-xs"
								data-testid="compose-send-shortcut"
							>
								Send
								<kbd className="type-caption rounded-md border border-border/70 px-1.5 py-0.5 font-mono">
									Enter
								</kbd>
							</span>
						}
						onAttach={() => setLastSelected("compose:attach")}
						onChange={setComposeDraft}
						onSend={({ content }) => submitCompose(content)}
						onStop={() => undefined}
						placeholder="Write a message…"
						status="ready"
						value={composeDraft}
					/>
				}
				dialogLayout="expanded"
				onOpenChange={setOpen}
				onTabChange={setActiveTab}
				open={open}
				tabs={[
					{ id: "all", label: "All" },
					{ id: "chats", label: "Chats" },
					{ id: "spaces", label: "Spaces" },
					{
						id: "plugin:com.ryu.canvas:boards",
						label: "Canvas",
					},
				]}
			/>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
