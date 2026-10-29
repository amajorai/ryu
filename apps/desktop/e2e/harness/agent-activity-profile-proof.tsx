import { I18nProvider } from "@ryu/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	AgentActivityPanel,
	AgentActivityTrigger,
} from "../../src/components/agents/AgentActivityPanel.tsx";
import {
	ChatHistoryProvider,
	useChatHistoryContext,
} from "../../src/contexts/ChatHistoryContext.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import type { AgentSummary } from "../../src/lib/api/agents.ts";
import type { ConnectionPhase } from "../../src/lib/connectivity.ts";
import { createTabsProofContext } from "./tabs-proof-context.ts";
import "../../src/index.css";

const AGENT_ID = "agent-muse";
const now = Date.now();
const yesterday = new Date(now);
yesterday.setDate(yesterday.getDate() - 1);
yesterday.setHours(15, 30, 0, 0);

const agent: AgentSummary = {
	avatarGlyph: { kind: "emoji", emoji: "🐈" },
	avatarUrl: null,
	builtIn: false,
	createdAt: new Date(now - 25 * 24 * 60 * 60 * 1000).toISOString(),
	description: "Researches trips and keeps the options easy to compare.",
	engine: "openai",
	id: AGENT_ID,
	installed: null,
	installHint: null,
	latestVersion: null,
	lifecycleStatus: "active",
	locked: false,
	model: "gpt-5-mini",
	name: "Muse",
	recommended: false,
	safetyProfile: "approval_required",
	systemPrompt: null,
	title: "Travel research",
	transport: null,
	version: "1.0.0",
	versionStatus: null,
};

const conversations = [
	{
		agent_id: AGENT_ID,
		branch: null,
		created_at: now - 2 * 60 * 60 * 1000,
		folder_path: null,
		id: "chat-muse-today",
		last_message: "Compared flight and lodging options for October dates.",
		last_message_at: now - 15 * 60 * 1000,
		last_message_role: "assistant",
		message_count: 8,
		run_status: "completed",
		title: "Plan Jackson Hole Trip",
		updated_at: now - 15 * 60 * 1000,
		worktree_path: null,
	},
	{
		agent_id: AGENT_ID,
		branch: null,
		created_at: yesterday.getTime() - 2 * 60 * 60 * 1000,
		folder_path: null,
		id: "chat-muse-yesterday",
		last_message: "Pulled account insights and summarized the results.",
		last_message_at: yesterday.getTime(),
		last_message_role: "assistant",
		message_count: 5,
		run_status: null,
		title: "Summarize social media data",
		updated_at: yesterday.getTime(),
		worktree_path: null,
	},
	{
		agent_id: "agent-other",
		branch: null,
		created_at: now,
		folder_path: null,
		id: "chat-other-agent",
		last_message: "This belongs to a different agent.",
		last_message_at: now,
		last_message_role: "assistant",
		message_count: 3,
		run_status: null,
		title: "Other agent private work",
		updated_at: now,
		worktree_path: null,
	},
];

function json<FixturePayload>(body: FixturePayload): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status: 200,
	});
}

function installProofNetwork() {
	const mockFetch: typeof window.fetch = Object.assign(
		async (input: RequestInfo | URL) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url.includes("/api/conversations")) {
				return json({ conversations });
			}
			// The list opts in to app jobs (`?include=app_jobs`), so match the path.
			if (url.split("?")[0].endsWith("/heartbeat/jobs")) {
				return json({ jobs: [] });
			}
			if (url.includes("/api/runs/stream")) {
				const frame = {
					agent_id: AGENT_ID,
					branch: null,
					created_at: yesterday.getTime(),
					folder_path: null,
					id: "chat-muse-yesterday",
					message_count: 5,
					run_status: "completed",
					title: "Summarize social media data",
					updated_at: yesterday.getTime(),
					worktree_path: null,
				};
				return new Response(
					`data: ${JSON.stringify({ type: "snapshot", runs: [frame] })}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" }, status: 200 }
				);
			}
			if (url.includes("/workflows")) {
				return json({ workflows: [] });
			}
			if (url.includes("/api/plugins/contributions")) {
				// The Calendar app owns the profile's schedule tab through its
				// manifest's `agent_profile_tabs`; the shell hardcodes no calendar.
				return json({
					agent_profile_tabs: [
						{
							companion: "calendar-companion",
							icon: "calendar-04",
							id: "calendar",
							plugin: "@ryu/calendar",
							title: "Calendar",
						},
					],
					companions: [
						{
							approved_grants: [],
							has_ui: true,
							id: "app__calendar-companion",
							label: "Calendar",
							name: "Calendar",
							plugin_id: "@ryu/calendar",
						},
					],
				});
			}
			return json({});
		},
		window.fetch
	);
	window.fetch = mockFetch;
}

function ActiveConversationProbe() {
	const { activeConversationId } = useChatHistoryContext();
	return (
		<output data-testid="active-conversation">
			{activeConversationId ?? "none"}
		</output>
	);
}

function ProofPage() {
	const [profileOpen, setProfileOpen] = useState(false);
	const tabsValue = createTabsProofContext({
		openTab: (path: string, options?: { conversationId?: string }) => {
			document.body.dataset.openedPath = path;
			if (options?.conversationId) {
				document.body.dataset.openedConversation = options.conversationId;
			}
			return options?.conversationId ?? path;
		},
	});
	return (
		<TabsContext.Provider value={tabsValue}>
			<main className="grid h-screen grid-cols-[minmax(0,1fr)_22.5rem] overflow-hidden bg-background text-foreground">
				<section aria-label="Chat preview" className="flex min-w-0 flex-col">
					<header className="flex h-12 shrink-0 items-center justify-between border-b px-5">
						<h1 className="font-medium text-sm">Jackson Hole trip</h1>
						<AgentActivityTrigger
							agentName={agent.name}
							onOpen={() => setProfileOpen(true)}
						/>
					</header>
					<div className="flex min-h-0 flex-1 flex-col justify-end gap-5 overflow-hidden px-10 py-8">
						<div className="max-w-[38rem] rounded-3xl bg-muted/60 px-5 py-4 text-sm leading-6">
							Can you find a good long weekend in Jackson Hole?
						</div>
						<div className="ml-auto max-w-[34rem] rounded-3xl bg-primary/10 px-5 py-4 text-sm leading-6">
							I'm comparing travel dates, flight times, and lodging prices for
							October.
						</div>
						<div className="max-w-[38rem] rounded-3xl bg-muted/60 px-5 py-4 text-sm leading-6">
							Keep the flights nonstop if the price difference is reasonable.
						</div>
						<div className="ml-auto max-w-[34rem] rounded-3xl bg-primary/10 px-5 py-4 text-sm leading-6">
							I'll put nonstop options first and show where they cost more.
						</div>
						<div className="max-w-[38rem] rounded-3xl bg-muted/60 px-5 py-4 text-sm leading-6">
							Could you compare flights and places to stay for October?
						</div>
						<div className="ml-auto max-w-[34rem] rounded-3xl bg-primary/10 px-5 py-4 text-sm leading-6">
							I compared the flight and lodging options. The activity list keeps
							this work attached to Muse.
						</div>
						<div className="rounded-3xl border px-5 py-4 text-muted-foreground text-sm">
							Message
						</div>
					</div>
				</section>
				{profileOpen ? (
					<aside className="min-h-0 border-l bg-sidebar">
						<AgentActivityPanel
							agent={agent}
							connectionPhase={"online" satisfies ConnectionPhase}
							organizationId={null}
							target={{ token: null, url: "http://127.0.0.1:8980" }}
						/>
					</aside>
				) : null}
			</main>
			<div className="sr-only">
				<ActiveConversationProbe />
			</div>
		</TabsContext.Provider>
	);
}

installProofNetwork();
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<I18nProvider>
			<ThemeProvider
				attribute="class"
				defaultTheme="light"
				enableSystem={false}
			>
				<QueryClientProvider client={queryClient}>
					<ChatHistoryProvider>
						<ProofPage />
					</ChatHistoryProvider>
				</QueryClientProvider>
			</ThemeProvider>
		</I18nProvider>
	);
}
