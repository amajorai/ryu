import { createTabsProofContext } from "./tabs-proof-context.ts";

declare const window: Window;

import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { GitGraphPanel } from "../../src/components/git/GitGraphPanel.tsx";
import { SidebarSideChats } from "../../src/components/layout/AppSidebar.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import type { BtwEntry } from "../../src/lib/api/btw.ts";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import "../../src/index.css";

const FOLDER = "/Users/jiawei/Documents/Code/ryu-closed";
const RECORD_SEPARATOR = "\x1e";

const ALL_LOG = [
	`${RECORD_SEPARATOR}merge123\tmerge123\tJia Wei Ng\t2 minutes ago\tmain456 feature789\t (HEAD -> codex/gateway-posture-doctor)\tMerge workspace changes`,
	`${RECORD_SEPARATOR}main456\tmain456\tJia Wei Ng\t18 minutes ago\troot000\t\tAdd project changes view`,
	`${RECORD_SEPARATOR}feature789\tfeature7\tJia Wei Ng\t24 minutes ago\troot000\t (feature/ui)\tShape the branch rail`,
	`${RECORD_SEPARATOR}root000\troot000\tJia Wei Ng\t1 hour ago\t\t\tOpen workspace`,
].join("");

const FEATURE_LOG = [
	`${RECORD_SEPARATOR}feature789\tfeature7\tJia Wei Ng\t24 minutes ago\troot000\t (feature/ui)\tShape the branch rail`,
	`${RECORD_SEPARATOR}root000\troot000\tJia Wei Ng\t1 hour ago\t\t\tOpen workspace`,
].join("");

const BRANCHES = [
	"*\tcodex/gateway-posture-doctor\tmerge123",
	" \tfeature/ui\tfeature789",
	" \tmain\tmain456",
].join("\n");

const STATUS =
	"## codex/gateway-posture-doctor\n M apps/desktop/src/components/layout/AppSidebar.tsx";

const SIDE_CHATS: BtwEntry[] = [
	{
		answer:
			"The branch lane keeps the parent thread visible while the aside stays lightweight.",
		conversation_id: "conversation-proof",
		created_at: Date.now() - 2 * 60 * 1000,
		id: "side-chat-1",
		kind: "btw",
		question: "Why does this branch split here?",
	},
	{
		answer: "Use the changes view when you want the file-level patch.",
		conversation_id: "conversation-proof",
		created_at: Date.now() - 12 * 60 * 1000,
		id: "side-chat-2",
		kind: "subagent",
		question: "Which files are touched?",
	},
];

interface TauriInternals {
	invoke: (
		command: string,
		args?: { command?: string }
	) => Promise<{ code: number; stderr: string; stdout: string }>;
}

const internals: TauriInternals = {
	invoke: async (_command, args) => {
		const command = args?.command ?? "";
		if (command.startsWith("git log feature/ui")) {
			return { code: 0, stderr: "", stdout: FEATURE_LOG };
		}
		if (command.startsWith("git log")) {
			return { code: 0, stderr: "", stdout: ALL_LOG };
		}
		if (command.startsWith("git branch")) {
			return { code: 0, stderr: "", stdout: BRANCHES };
		}
		if (command.startsWith("git status")) {
			return { code: 0, stderr: "", stdout: STATUS };
		}
		return { code: 0, stderr: "", stdout: "" };
	},
};

/* SAFETY: This module assigns the locally typed complete internals object to its own controlled fixture window. Its authored invoke routes return local git outputs; the intersection preserves Window rather than discarding its native type. */ (
	window as Window & { __TAURI_INTERNALS__: TauriInternals }
).__TAURI_INTERNALS__ = internals;

const realFetch = window.fetch.bind(globalThis);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
	if (url.includes("/api/conversations/") && url.endsWith("/btw")) {
		return Promise.resolve(
			new Response(JSON.stringify(SIDE_CHATS), {
				headers: { "content-type": "application/json" },
				status: 200,
			})
		);
	}
	return realFetch(input, init);
};

const tabs = createTabsProofContext({
	openTab: (path: string) => {
		const output = document.querySelector<HTMLOutputElement>(
			"[data-testid='opened-tab']"
		);
		if (output) {
			output.value = path;
			output.textContent = path;
		}
		return "proof-tab";
	},
});

const target: ApiTarget = { token: null, url: "http://proof.local" };

function Story() {
	const [sideChat, setSideChat] = useState("");
	return (
		<TabsContext.Provider value={tabs}>
			<ThemeProvider
				attribute="class"
				defaultTheme="dark"
				enableSystem={false}
				forcedTheme="dark"
			>
				<main className="min-h-screen bg-background p-6 text-foreground">
					<div className="mx-auto grid max-w-[1440px] gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
						<section className="overflow-hidden rounded-xl border border-border/70 bg-sidebar shadow-sm">
							<header className="border-border/70 border-b px-4 py-4">
								<p className="font-medium text-sm">Conversation</p>
								<p className="mt-1 text-muted-foreground text-xs">Side chats</p>
							</header>
							<div className="p-3" data-testid="side-chat-rail">
								<SidebarSideChats
									conversationId="conversation-proof"
									onOpen={(entry) => setSideChat(entry.question)}
									target={target}
								/>
							</div>
							{sideChat && (
								<p className="border-border/70 border-t px-4 py-3 text-muted-foreground text-xs">
									Opened: {sideChat}
								</p>
							)}
						</section>
						<section className="h-[760px] min-w-0 overflow-hidden rounded-xl border border-border/70 bg-background shadow-sm">
							<GitGraphPanel folder={FOLDER} />
						</section>
					</div>
					<output className="sr-only" data-testid="opened-tab" />
				</main>
			</ThemeProvider>
		</TabsContext.Provider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
