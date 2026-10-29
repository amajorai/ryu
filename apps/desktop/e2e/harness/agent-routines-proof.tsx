import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { createRoot } from "react-dom/client";
import { AgentRoutinesPanel } from "../../src/components/agents/AgentRoutinesPanel.tsx";
import { AgentRunHistoryView } from "../../src/components/agents/AgentRunHistoryView.tsx";
import { ChatHistoryProvider } from "../../src/contexts/ChatHistoryContext.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import { type ProofJsonValue, parseProofJsonRecord } from "../fixture-json.ts";
import { createTabsProofContext } from "./tabs-proof-context.ts";
import "../../src/index.css";

declare const window: Window;

// This synthetic transport retains the original raw POST fields, including malformed
// and future JSON values; it does not claim to be the production job DTO.
interface RoutineFixtureTransport {
	created_at: string;
	enabled: ProofJsonValue | undefined;
	history: ReturnType<typeof record>[];
	id: string;
	last_outcome: "failure" | "success" | null;
	last_run_at: string | null;
	name: ProofJsonValue | undefined;
	require_approval: ProofJsonValue | undefined;
	schedule: ProofJsonValue | undefined;
	target: ProofJsonValue | undefined;
	updated_at: string;
}

const AGENT_ID = "agent-routines";
const now = Date.now();

function record(
	outcome: "failure" | "success",
	offsetHours: number,
	error: string | null = null
) {
	const startedAt = new Date(now - offsetHours * 60 * 60 * 1000);
	const finishedAt = new Date(startedAt.getTime() + 2 * 60 * 1000);
	return {
		error,
		finished_at: finishedAt.toISOString(),
		outcome,
		run_id: `agentrun-proof-${offsetHours}`,
		started_at: startedAt.toISOString(),
	};
}

let mockJobs: RoutineFixtureTransport[] = [
	{
		created_at: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
		enabled: true,
		history: [record("success", 20), record("success", 4)],
		id: "routine-morning-brief",
		last_outcome: "success",
		last_run_at: new Date(now - 4 * 60 * 60 * 1000).toISOString(),
		name: "Morning research brief",
		require_approval: false,
		schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "Asia/Singapore" },
		target: {
			agent_id: AGENT_ID,
			conversation_id: "chat-command-center",
			prompt:
				"Review the latest project activity and summarize what needs attention.",
			type: "agent",
		},
		updated_at: new Date(now - 4 * 60 * 60 * 1000).toISOString(),
	},
	{
		created_at: new Date(now - 72 * 60 * 60 * 1000).toISOString(),
		enabled: true,
		history: [
			record("failure", 8, "Browser provider was unavailable"),
			record("success", 28),
		],
		id: "routine-release-watch",
		last_outcome: "failure",
		last_run_at: new Date(now - 8 * 60 * 60 * 1000).toISOString(),
		name: "Release watch",
		require_approval: true,
		schedule: { kind: "every", interval: "2h" },
		target: {
			agent_id: AGENT_ID,
			prompt:
				"Check the release board and flag anything that needs a decision.",
			type: "agent",
		},
		updated_at: new Date(now - 8 * 60 * 60 * 1000).toISOString(),
	},
	{
		created_at: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
		enabled: false,
		history: [],
		id: "routine-weekly-review",
		last_outcome: null,
		last_run_at: null,
		name: "Weekly planning review",
		require_approval: false,
		schedule: { kind: "cron", expr: "30 16 * * 5", tz: "UTC" },
		target: {
			agent_id: AGENT_ID,
			prompt: "Prepare a concise planning review.",
			type: "agent",
		},
		updated_at: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
	},
];

const conversations = [
	{
		agent_id: AGENT_ID,
		created_at: now - 72 * 60 * 60 * 1000,
		id: "chat-command-center",
		message_count: 12,
		run_status: "completed",
		title: "Agent command center",
		updated_at: now - 4 * 60 * 60 * 1000,
	},
	{
		agent_id: AGENT_ID,
		created_at: now - 24 * 60 * 60 * 1000,
		id: "chat-release-planning",
		message_count: 4,
		run_status: null,
		title: "Release planning",
		updated_at: now - 20 * 60 * 60 * 1000,
	},
];

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

function installProofNetwork() {
	window.fetch = async (input, init) => {
		const url = isNativeText(input)
			? input
			: input instanceof URL
				? input.href
				: input.url;
		const method = init?.method ?? "GET";
		if (url.includes("/api/runs/stream")) {
			return new Response(
				`data: ${JSON.stringify({
					type: "snapshot",
					runs: [
						{
							agent_id: AGENT_ID,
							branch: null,
							created_at: now - 8 * 60 * 60 * 1000,
							folder_path: null,
							id: "chat-command-center",
							message_count: 12,
							run_status: "completed",
							title: "Agent command center",
							updated_at: now - 4 * 60 * 60 * 1000,
							worktree_path: null,
						},
					],
				})}

`,
				{ headers: { "Content-Type": "text/event-stream" }, status: 200 }
			);
		}
		if (url.includes("/api/conversations")) {
			return json({ conversations });
		}
		// The list opts in to app jobs (`?include=app_jobs`), so match the path.
		if (url.split("?")[0].endsWith("/heartbeat/jobs") && method === "GET") {
			return json({ jobs: mockJobs });
		}
		if (url.includes("/heartbeat/jobs/") && method === "PUT") {
			const id = url.split("/heartbeat/jobs/")[1];
			const job = mockJobs.find((candidate) => candidate.id === id);
			return job
				? json({ job: { ...job, updated_at: new Date().toISOString() } })
				: json({}, 404);
		}
		if (url.includes("/heartbeat/jobs/") && method === "POST") {
			return json({ success: true, run_id: "agentrun-proof-manual" });
		}
		if (url.includes("/heartbeat/jobs/") && method === "DELETE") {
			const id = url.split("/heartbeat/jobs/")[1];
			mockJobs = mockJobs.filter((candidate) => candidate.id !== id);
			return json({ success: true });
		}
		if (url.endsWith("/heartbeat/jobs") && method === "POST") {
			const body = parseProofJsonRecord(String(init?.body ?? "{}"));
			const target = body.target;
			const job = {
				created_at: new Date().toISOString(),
				enabled: body.enabled ?? true,
				history: [],
				id: `routine-proof-${Date.now()}`,
				last_outcome: null,
				last_run_at: null,
				name: body.name,
				require_approval: body.require_approval ?? false,
				schedule: body.schedule,
				target,
				updated_at: new Date().toISOString(),
			};
			mockJobs = [...mockJobs, job];
			return json({ job });
		}
		return json({});
	};
}

function ProofPage() {
	const tabsValue = createTabsProofContext({
		openTab: () => "routine-proof-tab",
	});
	return (
		<main className="min-h-screen bg-background px-6 py-10 text-foreground">
			<div className="mx-auto max-w-4xl">
				<header className="mb-8">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Production component proof
					</p>
					<h1 className="mt-2 font-semibold text-4xl tracking-tight">
						Agent routines
					</h1>
					<p className="mt-3 max-w-2xl text-muted-foreground">
						Durable schedules, persistent chat destinations, and a 24-hour
						run-health view in the agent workspace.
					</p>
				</header>
				<section className="rounded-3xl border bg-card p-5 shadow-sm">
					<TabsContext.Provider value={tabsValue}>
						<AgentRoutinesPanel agentId={AGENT_ID} />
						<div className="my-8 border-t" />
						<AgentRunHistoryView agentId={AGENT_ID} />
					</TabsContext.Provider>
				</section>
			</div>
		</main>
	);
}

installProofNetwork();
const proofWindow =
	/* SAFETY: This private optional __agentRoutinesProofRoot holder is authored only by this module, which stores the complete native createRoot result and reuses it on later evaluation. The view preserves the browser Window and does not describe an external payload. */ window as Window & {
		__agentRoutinesProofRoot?: ReturnType<typeof createRoot>;
	};
const proofRoot =
	proofWindow.__agentRoutinesProofRoot ??
	createRoot(document.getElementById("root")!);
proofWindow.__agentRoutinesProofRoot = proofRoot;
proofRoot.render(
	<ChatHistoryProvider>
		<ProofPage />
	</ChatHistoryProvider>
);
