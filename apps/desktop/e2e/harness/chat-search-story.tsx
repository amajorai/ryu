import { HotkeysProvider, useHotkey } from "@ryu/hotkeys/react";
import type { UIMessage } from "ai";
import { useEffect, useMemo, useState } from "react";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import {
	ChatSearchBar,
	type ChatSearchMode,
} from "../../src/components/chat/ChatSearchBar.tsx";
import { searchChatMessages } from "../../src/lib/chat-search.ts";
import { DESKTOP_HOTKEYS } from "../../src/lib/hotkeys/actions.ts";
import "../../src/index.css";

const MESSAGES = [
	{
		id: "user-deployment",
		role: "user",
		parts: [{ type: "text", text: "Check the deployment plan" }],
	},
	{
		id: "assistant-deployment",
		role: "assistant",
		parts: [{ type: "text", text: "The deployment plan is staged." }],
	},
	{
		id: "user-readme",
		role: "user",
		parts: [{ type: "text", text: "Read the README for setup" }],
	},
	{
		id: "assistant-readme",
		role: "assistant",
		parts: [{ type: "text", text: "README explains the local setup." }],
	},
] as unknown as UIMessage[];

const FILES = ["README.md", "src/chat-search.ts", "src/components/chat.tsx"];

function SearchStory() {
	const [mode, setMode] = useState<ChatSearchMode>("chat");
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [activeMatchIndex, setActiveMatchIndex] = useState(0);
	const matches = useMemo(
		() => (mode === "chat" ? searchChatMessages(MESSAGES, query) : []),
		[mode, query]
	);
	const activeMatch = matches[activeMatchIndex] ?? null;

	const toggleSearch = () => {
		setActiveMatchIndex(0);
		if (!open) {
			setMode("chat");
			setQuery("");
			setOpen(true);
			return;
		}
		setMode((current) => (current === "chat" ? "files" : "chat"));
	};

	useHotkey("chat.search", toggleSearch);

	useEffect(() => {
		setActiveMatchIndex((current) =>
			matches.length === 0 ? 0 : Math.min(current, matches.length - 1)
		);
	}, [matches.length]);

	const nextMatch = () => {
		setActiveMatchIndex((current) =>
			matches.length === 0 ? 0 : (current + 1) % matches.length
		);
	};
	const previousMatch = () => {
		setActiveMatchIndex((current) =>
			matches.length === 0 ? 0 : (current - 1 + matches.length) % matches.length
		);
	};

	return (
		<div className="flex h-screen flex-col bg-background">
			<div
				className="flex h-12 shrink-0 items-center justify-between border-b px-4"
				data-testid="search-state"
			>
				<span className="font-medium text-sm">Chat</span>
				<span className="text-muted-foreground text-xs">
					{open ? `${mode} search` : "Press Ctrl+F"}
				</span>
			</div>
			<div className="relative flex min-h-0 flex-1 overflow-hidden">
				{open && (
					<ChatSearchBar
						activeMatchIndex={activeMatchIndex}
						folderAvailable
						matches={matches}
						mode={mode}
						onClose={() => setOpen(false)}
						onModeChange={(nextMode) => {
							setMode(nextMode);
							setActiveMatchIndex(0);
						}}
						onNextMatch={nextMatch}
						onPreviousMatch={previousMatch}
						onQueryChange={(nextQuery) => {
							setQuery(nextQuery);
							setActiveMatchIndex(0);
						}}
						query={query}
					/>
				)}
				<div className="min-w-0 flex-1">
					<ChatDisplayPrefs>
						<AgentChat
							conversationKey="search-story"
							currentUser={{ id: "user", name: "You" }}
							initialScrollBehavior="top"
							messages={MESSAGES}
							onSend={() => undefined}
							searchActiveMessageId={activeMatch?.messageId}
							showCopyToolbar={false}
							status="ready"
						/>
					</ChatDisplayPrefs>
				</div>
				{open && mode === "files" && (
					<aside
						aria-label="Project files"
						className="w-72 shrink-0 border-l bg-sidebar p-4"
						data-testid="file-search-panel"
					>
						<h2 className="font-medium text-sm">Project files</h2>
						<p className="mt-1 text-muted-foreground text-xs">
							The chat's Files dock is active.
						</p>
						<div className="mt-4 flex flex-col gap-1">
							{FILES.filter((file) =>
								file
									.toLocaleLowerCase()
									.includes(query.trim().toLocaleLowerCase())
							).map((file) => (
								<div
									className="rounded-md px-2 py-1.5 font-mono text-xs"
									data-file-name={file}
									key={file}
								>
									{file}
								</div>
							))}
						</div>
					</aside>
				)}
			</div>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	root.replaceChildren();
	const { createRoot } = await import("react-dom/client");
	createRoot(root).render(
		<HotkeysProvider registry={DESKTOP_HOTKEYS}>
			<SearchStory />
		</HotkeysProvider>
	);
}
