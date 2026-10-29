declare const window: Window;

import { Logo } from "@ryu/ui/components/logo.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BotProfileCard } from "../../src/components/bot/BotProfileCard.tsx";
import {
	type AppSurface,
	AppSurfaceProvider,
} from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import {
	TabsProvider,
	useTabsContext,
} from "../../src/contexts/TabsContext.tsx";
import type { ActivityItem } from "../../src/lib/api/activity.ts";
import { useLiveActivityStore } from "../../src/store/useLiveActivityStore.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import type { Conversation } from "../../types/chat.ts";

import "../../src/index.css";

interface ProofRequest {
	body?: unknown;
	headers: Record<string, string>;
	method: string;
	url: string;
}

interface ProofState {
	activeTabId: string;
	emptyGoals: boolean;
	failNext: {
		activityLoad: number;
		approvalLoad: number;
		approvalMutation: number;
		goalLoad: number;
		goalPause: number;
		goalResume: number;
	};
	openedTabs: Array<{
		conversationId?: string;
		initialPrompt?: string;
		path: string;
		title: string;
	}>;
	requests: ProofRequest[];
}

declare global {
	interface Window {
		__botProfileCardProof?: ProofState;
	}
}

function ProofTabsObserver() {
	const { activeTabId, tabs } = useTabsContext();
	useEffect(() => {
		const proof = window.__botProfileCardProof;
		if (!proof) {
			return;
		}
		proof.activeTabId = activeTabId;
		proof.openedTabs = tabs.map(
			({ conversationId, initialPrompt, path, title }) => ({
				conversationId,
				initialPrompt,
				path,
				title,
			})
		);
	}, [activeTabId, tabs]);
	return null;
}

window.addEventListener("error", (event) => {
	const message =
		event.error instanceof Error ? event.error.message : event.message;
	document.body.dataset.proofError = message;
	document.body.innerHTML = `<pre data-testid="proof-error">${message}</pre>`;
});
window.addEventListener("unhandledrejection", (event) => {
	const message = String(event.reason);
	document.body.dataset.proofError = message;
	document.body.innerHTML = `<pre data-testid="proof-error">${message}</pre>`;
});

const PROOF_NODE = {
	name: "proof",
	token: "node-token-proof",
	url: "http://proof.local",
	userJwt: null,
};

const now = Math.floor(Date.now() / 1000);
const activityItems: ActivityItem[] = [
	{
		agent_id: "ryu",
		body: "Pulled the open work from three chats into one next-step summary.",
		created_at: now - 6 * 60,
		id: "activity-summary",
		kind: "run",
		level: "success",
		metadata: {},
		session_id: "chat-goal",
		source: "runs",
		title: "Completed a planning pass",
	},
	{
		agent_id: "ryu",
		body: "The weekly review found two stale follow-ups worth keeping visible.",
		created_at: now - 48 * 60,
		id: "activity-goal",
		kind: "quest",
		level: "info",
		metadata: {},
		session_id: "chat-goal",
		source: "quests",
		title: "Kept two follow-ups in view",
	},
	{
		agent_id: "ryu",
		body: "A message is ready, but Ryu is waiting for your approval before sending it.",
		created_at: now - 2 * 60 * 60,
		id: "activity-approval",
		kind: "approval",
		level: "warning",
		metadata: {},
		session_id: null,
		source: "approvals",
		title: "Draft reply needs approval",
	},
	{
		agent_id: "ryu",
		body: "The deploy monitor saw a retry after the staging rollout.",
		created_at: now - 3 * 60 * 60,
		id: "activity-watch",
		kind: "monitor_alert",
		level: "warning",
		metadata: {},
		session_id: null,
		source: "monitors",
		title: "Monitor caught a deployment retry",
	},
];

const conversations: Conversation[] = [
	{
		createdAt: now * 1000 - 86_400_000,
		id: "chat-goal",
		lastMessage: "Continue the launch plan",
		lastMessageAt: now * 1000 - 6 * 60_000,
		messageCount: 8,
		messages: [],
		title: "Launch plan",
		updatedAt: now * 1000 - 6 * 60_000,
	},
	{
		createdAt: now * 1000 - 172_800_000,
		id: "chat-passive",
		lastMessage: "Keep the research thread open",
		lastMessageAt: now * 1000 - 2 * 3_600_000,
		messageCount: 4,
		messages: [],
		title: "Research thread",
		updatedAt: now * 1000 - 2 * 3_600_000,
	},
];

const pendingApproval = {
	action: { type: "tool_call", tool_id: "send_message" },
	agent_id: "ryu",
	conversation_id: "chat-goal",
	created_at: new Date((now - 2 * 60 * 60) * 1000).toISOString(),
	id: "approval-send-message",
	kind: "tool_call",
	risk_tags: ["external_message"],
	status: "pending",
	summary: "Send the drafted launch update to the project channel.",
	title: "Send launch update",
};

const secondPendingApproval = {
	...pendingApproval,
	conversation_id: "chat-passive",
	id: "approval-review-project-note",
	summary: "Send this only after your review.",
	title: "Post the reviewed project note",
};

const goalStates = new Map([
	[
		"chat-goal",
		{
			goal: "Turn the launch notes into a shippable checklist",
			last_reason:
				"The checklist is taking shape; a few owners are still missing.",
			status: "active",
			turns: 4,
		},
	],
	[
		"chat-passive",
		{
			goal: "Keep the research thread warm for the next planning review",
			last_reason: "Paused until the next review window.",
			status: "paused",
			turns: 2,
		},
	],
]);

function jsonResponse<FixturePayload>(
	value: FixturePayload,
	_ignoredStatus?: number
): Response;
function jsonResponse<FixturePayload>(value: FixturePayload): Response {
	return new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json" },
		status: 200,
	});
}

function installProofData() {
	const params = new URLSearchParams(window.location.search);
	if (params.has("reset")) {
		for (const key of [
			"ryu:bot-profile-card-collapsed:v1",
			"ryu:bot-feed-preferences:v1",
			"ryu:bot-feed-engagement:v1",
		]) {
			localStorage.removeItem(key);
		}
	}
	const proof: ProofState = {
		activeTabId: "",
		emptyGoals: params.get("emptyGoals") === "1",
		failNext: {
			activityLoad: params.get("failActivityOnce") === "1" ? 1 : 0,
			approvalLoad: params.get("failApprovalOnce") === "1" ? 1 : 0,
			approvalMutation: 0,
			goalLoad: Number(params.get("failGoalReadsOnce") ?? "0"),
			goalPause: 0,
			goalResume: 0,
		},
		openedTabs: [],
		requests: [],
	};
	window.__botProfileCardProof = proof;
	for (const key of [
		"reset",
		"emptyGoals",
		"failActivityOnce",
		"failApprovalOnce",
		"failGoalReadsOnce",
	]) {
		params.delete(key);
	}
	const remainingQuery = params.toString();
	const nextUrl = `${window.location.pathname}${remainingQuery ? `?${remainingQuery}` : ""}`;
	window.history.replaceState(window.history.state, "", nextUrl);
	useNodeStore.setState({ defaultNode: PROOF_NODE.name, nodes: [PROOF_NODE] });
	useLiveActivityStore.getState().reset();
	useLiveActivityStore.getState().upsert({
		action: { kind: "route", path: "/chat" },
		appId: "shell",
		detail: "Preparing the launch checklist",
		id: "run:launch-plan",
		kind: "agent-run",
		startedAt: Date.now() - 60_000,
		status: "running",
		title: "Working on launch plan",
		updatedAt: Date.now(),
	});

	const realFetch = window.fetch.bind(globalThis);
	const decisions = new Map<string, "approved" | "rejected">();
	const approvals = [pendingApproval, secondPendingApproval];
	window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : null;
		const url =
			input instanceof URL ? input.toString() : (request?.url ?? String(input));
		if (!url.startsWith(`${PROOF_NODE.url}/`)) {
			return realFetch(input, init);
		}
		const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
		const headers = new Headers(init?.headers ?? request?.headers);
		const requestBody = isNativeText(init?.body)
			? JSON.parse(init.body)
			: undefined;
		const parsedUrl = new URL(url);
		proof.requests.push({
			...(requestBody === undefined ? undefined : { body: requestBody }),
			headers: Object.fromEntries(headers.entries()),
			method,
			url,
		});
		if (parsedUrl.pathname === "/api/activity" && method === "GET") {
			if (proof.failNext.activityLoad > 0) {
				proof.failNext.activityLoad -= 1;
				return new Response(
					JSON.stringify({ error: "Activity temporarily unavailable" }),
					{
						headers: { "content-type": "application/json" },
						status: 503,
					}
				);
			}
			return jsonResponse({ items: activityItems });
		}
		if (parsedUrl.pathname === "/api/approvals" && method === "GET") {
			if (proof.failNext.approvalLoad > 0) {
				proof.failNext.approvalLoad -= 1;
				return new Response(
					JSON.stringify({ error: "Approval queue temporarily unavailable" }),
					{
						headers: { "content-type": "application/json" },
						status: 503,
					}
				);
			}
			return jsonResponse({
				approvals: approvals.flatMap((approval) => {
					const status = decisions.get(approval.id) ?? approval.status;
					return status === "pending" ? [{ ...approval, status }] : [];
				}),
			});
		}
		const goalMatch = parsedUrl.pathname.match(
			/^\/api\/conversations\/([^/]+)\/goal$/
		);
		if (goalMatch && method === "GET") {
			if (proof.failNext.goalLoad > 0) {
				proof.failNext.goalLoad -= 1;
				return new Response(
					JSON.stringify({ error: "Goals temporarily unavailable" }),
					{
						headers: { "content-type": "application/json" },
						status: 503,
					}
				);
			}
			if (proof.emptyGoals) {
				return jsonResponse({ turns: 0 });
			}
			return jsonResponse(
				goalStates.get(decodeURIComponent(goalMatch[1])) ?? { turns: 0 }
			);
		}
		const approvalMatch = parsedUrl.pathname.match(
			/^\/api\/approvals\/([^/]+)\/(approve|reject)$/
		);
		if (approvalMatch && method === "POST") {
			if (proof.failNext.approvalMutation > 0) {
				proof.failNext.approvalMutation -= 1;
				return new Response(
					JSON.stringify({ error: "Decision temporarily unavailable" }),
					{
						headers: { "content-type": "application/json" },
						status: 503,
					}
				);
			}
			const approvalId = decodeURIComponent(approvalMatch[1]);
			const status = approvalMatch[2] === "approve" ? "approved" : "rejected";
			decisions.set(approvalId, status);
			return jsonResponse({
				approval: {
					...approvals.find((approval) => approval.id === approvalId),
					status,
				},
			});
		}
		const goalMutation = parsedUrl.pathname.match(
			/^\/api\/conversations\/([^/]+)\/goal\/(pause|resume)$/
		);
		if (goalMutation && method === "POST") {
			const action = goalMutation[2];
			const failureKey = action === "pause" ? "goalPause" : "goalResume";
			if (proof.failNext[failureKey] > 0) {
				proof.failNext[failureKey] -= 1;
				return new Response(
					JSON.stringify({ error: "Goal update temporarily unavailable" }),
					{
						headers: { "content-type": "application/json" },
						status: 503,
					}
				);
			}
			const conversationId = decodeURIComponent(goalMutation[1]);
			const state = goalStates.get(conversationId);
			if (state) {
				state.status = action === "pause" ? "paused" : "active";
			}
			return jsonResponse(state ?? { turns: 0 });
		}
		return jsonResponse({ error: "Unsupported proof request" }, 404);
	};
}

function surfaceFromUrl(): AppSurface {
	return new URLSearchParams(window.location.search).get("surface") === "web"
		? "web"
		: "desktop";
}

function Story() {
	installProofData();
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<AppSurfaceProvider surface={surfaceFromUrl()}>
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<TabsProvider initialTab={{ path: "/chat", title: "New chat" }}>
						<ProofTabsObserver />
						<Toaster position="bottom-right" theme="dark" />
						<main className="min-h-screen bg-background p-8 text-foreground">
							<div className="mx-auto flex min-h-[780px] max-w-5xl overflow-hidden rounded-3xl border border-border/70 bg-sidebar shadow-2xl">
								<aside className="w-[390px] shrink-0 border-sidebar-border border-r p-3">
									<div className="mb-3 flex items-center gap-2 px-2">
										<Logo size="20px" variant="outline" />
										<div>
											<p className="font-medium text-sm">Bot</p>
											<p className="type-compact text-muted-foreground">
												Managed chat workspace
											</p>
										</div>
									</div>
									<BotProfileCard conversations={conversations} />
								</aside>
								<section className="flex min-w-0 flex-1 items-center justify-center bg-background p-8">
									<div className="max-w-sm text-center">
										<p className="font-medium text-lg">What can I help with?</p>
										<p className="mt-2 text-muted-foreground text-sm">
											The profile card keeps background work, approvals, goals,
											and the feed close without turning the chat into a
											dashboard.
										</p>
									</div>
								</section>
							</div>
						</main>
					</TabsProvider>
				</EntitlementProvider>
			</QueryClientProvider>
		</AppSurfaceProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
