import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AgentRunHistoryView } from "../../src/components/agents/AgentRunHistoryView.tsx";
import {
	ChatHistoryProvider,
	useChatHistoryContext,
} from "../../src/contexts/ChatHistoryContext.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import { createTabsProofContext } from "./tabs-proof-context.ts";
import "../../src/index.css";

const AGENT_ID = "agent-run-history-proof";
const now = Date.now();

interface ConversationSummary {
	agent_id: string | null;
	branch: string | null;
	created_at: number;
	folder_path: string | null;
	id: string;
	message_count: number;
	run_status: string | null;
	title: string | null;
	updated_at: number;
	worktree_path: string | null;
}

interface RecordedRequest {
	method: string;
	path: string;
}

interface OpenedTab {
	options: NonNullable<
		Parameters<ReturnType<typeof createTabsProofContext>["openTab"]>[1]
	>;
	path: string;
}

interface RunHistoryFixture {
	activeConversationId: string | null;
	conversations: ConversationSummary[];
	failNextConversationList: boolean;
	openedTabs: OpenedTab[];
	readonly requests: RecordedRequest[];
}

declare global {
	interface Window {
		__agentRunHistoryFixture?: RunHistoryFixture;
	}
}

function seededConversations(): ConversationSummary[] {
	return [
		{
			agent_id: AGENT_ID,
			branch: null,
			created_at: now,
			folder_path: null,
			id: "chat-command-center",
			message_count: 12,
			run_status: null,
			title: "Agent command center",
			updated_at: now,
			worktree_path: null,
		},
		{
			agent_id: AGENT_ID,
			branch: null,
			created_at: now - 60_000,
			folder_path: null,
			id: "chat-release-planning",
			message_count: 4,
			run_status: null,
			title: "Release planning",
			updated_at: now - 60_000,
			worktree_path: null,
		},
		{
			agent_id: AGENT_ID,
			branch: null,
			created_at: now - 120_000,
			folder_path: null,
			id: "agentrun_nightly-report",
			message_count: 6,
			run_status: "failed",
			title: "Nightly agent report",
			updated_at: now - 120_000,
			worktree_path: null,
		},
		{
			agent_id: "another-agent",
			branch: null,
			created_at: now + 60_000,
			folder_path: null,
			id: "chat-other-agent",
			message_count: 1,
			run_status: null,
			title: "Private agent conversation",
			updated_at: now + 60_000,
			worktree_path: null,
		},
	];
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

function installFixture(): RunHistoryFixture {
	const query = new URLSearchParams(window.location.search);
	const fixture: RunHistoryFixture = {
		activeConversationId: null,
		conversations: query.has("empty") ? [] : seededConversations(),
		failNextConversationList: false,
		openedTabs: [],
		requests: [],
	};
	window.__agentRunHistoryFixture = fixture;

	window.fetch = async (input, init) => {
		const requestUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(requestUrl, window.location.href);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		fixture.requests.push({ method, path: url.pathname });

		if (url.pathname.endsWith("/api/runs/stream")) {
			const frame = `data: ${JSON.stringify({ type: "snapshot", runs: [] })}\n\n`;
			const encoder = new TextEncoder();
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(frame));
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" }, status: 200 }
			);
		}
		if (url.pathname.endsWith("/api/conversations")) {
			if (fixture.failNextConversationList) {
				fixture.failNextConversationList = false;
				return json(
					{ error: "Local conversation history is unavailable." },
					503
				);
			}
			return json({ conversations: fixture.conversations });
		}
		if (url.pathname.endsWith("/heartbeat/jobs")) {
			return json({ jobs: [] });
		}
		return json({});
	};
	return fixture;
}

function ActiveConversationProbe() {
	const { activeConversationId } = useChatHistoryContext();
	useEffect(() => {
		const fixture = window.__agentRunHistoryFixture;
		if (fixture) {
			fixture.activeConversationId = activeConversationId;
		}
	}, [activeConversationId]);
	return null;
}

function ProofPage() {
	const fixture = window.__agentRunHistoryFixture;
	const tabsValue = createTabsProofContext({
		openTab: (
			path: string,
			options: NonNullable<
				Parameters<ReturnType<typeof createTabsProofContext>["openTab"]>[1]
			> = {}
		) => {
			fixture?.openedTabs.push({ options, path });
			return "proof-opened-tab";
		},
	});
	return (
		<main className="min-h-screen bg-background px-6 py-10 text-foreground">
			<div className="mx-auto max-w-4xl">
				<header className="mb-8">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Production component proof
					</p>
					<h1 className="mt-2 font-semibold text-4xl tracking-tight">
						Agent run history
					</h1>
					<p className="mt-3 max-w-2xl text-muted-foreground">
						Review this agent&apos;s conversations and reopen a complete
						transcript.
					</p>
				</header>
				<section className="rounded-3xl border bg-card p-5 shadow-sm">
					<TabsContext.Provider value={tabsValue}>
						<AgentRunHistoryView agentId={AGENT_ID} />
					</TabsContext.Provider>
				</section>
			</div>
		</main>
	);
}

installFixture();
const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Agent run history harness root is missing.");
}
createRoot(rootElement).render(
	<ChatHistoryProvider>
		<ActiveConversationProbe />
		<ProofPage />
	</ChatHistoryProvider>
);
