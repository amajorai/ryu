import {
	isNativeBoolean,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import { createTabsProofContext } from "./tabs-proof-context.ts";

declare const window: Window;

import { createRoot } from "react-dom/client";
import { AgentRoutinesPanel } from "../../src/components/agents/AgentRoutinesPanel.tsx";
import { ChatHistoryProvider } from "../../src/contexts/ChatHistoryContext.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const AGENT_ID = "agent-routines";
const STORAGE_KEY = "ryu:e2e:agent-routines-interactions";
const now = Date.now();

type ScheduleWire =
	| { expr: string; kind: "cron"; tz?: string | null }
	| { interval: string; kind: "every" };

interface TargetWire {
	agent_id: string;
	conversation_id?: string | null;
	prompt: string;
	type: "agent";
}

const scheduleSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("cron"),
		expr: z.string(),
		tz: z.string().nullable().optional(),
	}),
	z.object({ kind: z.literal("every"), interval: z.string() }),
]);
const targetSchema = z.object({
	agent_id: z.string(),
	conversation_id: z.string().nullable().optional(),
	prompt: z.string(),
	type: z.literal("agent"),
});
const routineInputSchema = z.object({
	enabled: z.boolean().optional(),
	name: z.string().optional(),
	require_approval: z.boolean().optional(),
	schedule: scheduleSchema.optional(),
	target: targetSchema.optional(),
});
interface ExecutionWire {
	error: string | null;
	finished_at: string;
	outcome: "failure" | "success";
	run_id: string;
	started_at: string;
}

interface JobWire {
	created_at: string;
	enabled: boolean;
	history: ExecutionWire[];
	id: string;
	last_outcome: "failure" | "success" | null;
	last_run_at: string | null;
	name: string;
	owner_app?: string | null;
	require_approval: boolean;
	schedule: ScheduleWire;
	target: TargetWire;
	updated_at: string;
}

interface RecordedRequest {
	body: unknown;
	method: string;
	path: string;
}

interface RoutineFixtureControls {
	failNextCreate: boolean;
	failNextList: boolean;
	failNextUpdate: boolean;
	holdNextRun: boolean;
	releaseHeldRun: (() => void) | null;
	renameOnNextList: { id: string; name: string } | null;
	readonly requests: RecordedRequest[];
}

declare global {
	interface Window {
		__agentRoutinesInteractionsFixture?: RoutineFixtureControls;
	}
}

function execution(
	outcome: "failure" | "success",
	offsetHours: number,
	error: string | null = null
): ExecutionWire {
	const startedAt = new Date(now - offsetHours * 60 * 60 * 1000);
	const finishedAt = new Date(startedAt.getTime() + 2 * 60 * 1000);
	return {
		error,
		finished_at: finishedAt.toISOString(),
		outcome,
		run_id: `routine-interaction-run-${offsetHours}`,
		started_at: startedAt.toISOString(),
	};
}

function seededJobs(): JobWire[] {
	return [
		{
			created_at: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
			enabled: true,
			history: [execution("success", 20), execution("success", 4)],
			id: "routine-morning-brief",
			last_outcome: "success",
			last_run_at: new Date(now - 4 * 60 * 60 * 1000).toISOString(),
			name: "Morning research brief",
			require_approval: false,
			schedule: { expr: "0 9 * * 1-5", kind: "cron", tz: "Asia/Singapore" },
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
				execution("failure", 8, "Browser provider was unavailable"),
				execution("success", 28),
			],
			id: "routine-release-watch",
			last_outcome: "failure",
			last_run_at: new Date(now - 8 * 60 * 60 * 1000).toISOString(),
			name: "Release watch",
			require_approval: true,
			schedule: { interval: "2h", kind: "every" },
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
			schedule: { expr: "30 16 * * 5", kind: "cron", tz: "UTC" },
			target: {
				agent_id: AGENT_ID,
				prompt: "Prepare a concise planning review.",
				type: "agent",
			},
			updated_at: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
		},
	];
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

function readStoredJobs(): JobWire[] {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (!stored) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(stored);
		// SAFETY: This private key is seeded by complete seededJobs and then written only by the local create/update/delete/run handlers. Their schedule and agent target come from the mounted AgentRoutinesPanel draft constructors through native schedules.ts serializers; run history is authored here. The proof spec does not inject raw storage or foreign requests.
		return Array.isArray(parsed) ? (parsed as JobWire[]) : [];
	} catch {
		return [];
	}
}

function writeStoredJobs(jobs: JobWire[]): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
}

function recordRequest(
	fixture: RoutineFixtureControls,
	path: string,
	method: string,
	body: BodyInit | null | undefined
) {
	const parsedBody = isNativeText(body) ? parseProofJson(body) : null;
	fixture.requests.push({ body: parsedBody, method, path });
	return parsedBody;
}

function installLocalScheduler(): void {
	const query = new URLSearchParams(window.location.search);
	if (localStorage.getItem(STORAGE_KEY) === null) {
		writeStoredJobs(query.has("empty") ? [] : seededJobs());
	}

	const fixture: RoutineFixtureControls = {
		failNextCreate: false,
		failNextList: query.has("fail-list-once"),
		failNextUpdate: false,
		holdNextRun: false,
		requests: [],
		releaseHeldRun: null,
		renameOnNextList: null,
	};
	window.__agentRoutinesInteractionsFixture = fixture;

	window.fetch = async (input, init) => {
		const requestUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(requestUrl, window.location.href);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		const body = recordRequest(fixture, url.pathname, method, init?.body);

		if (url.pathname.includes("/api/runs/stream")) {
			return new Response(
				`data: ${JSON.stringify({ type: "snapshot", runs: [] })}\n\n`,
				{ headers: { "Content-Type": "text/event-stream" }, status: 200 }
			);
		}
		if (url.pathname === "/api/conversations") {
			return json({
				conversations: [
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
						created_at: now - 1,
						folder_path: null,
						id: "chat-release-planning",
						message_count: 4,
						run_status: null,
						title: "Release planning",
						updated_at: now - 1,
						worktree_path: null,
					},
				],
			});
		}
		if (url.pathname === "/heartbeat/jobs" && method === "GET") {
			if (fixture.failNextList) {
				fixture.failNextList = false;
				return json({ error: "Local scheduler is unavailable." }, 503);
			}
			let jobs = readStoredJobs();
			if (fixture.renameOnNextList) {
				jobs = jobs.map((job) =>
					job.id === fixture.renameOnNextList?.id
						? { ...job, name: fixture.renameOnNextList.name }
						: job
				);
				fixture.renameOnNextList = null;
				writeStoredJobs(jobs);
			}
			return json({ jobs });
		}
		if (url.pathname === "/heartbeat/jobs" && method === "POST") {
			if (fixture.failNextCreate) {
				fixture.failNextCreate = false;
				return json({ error: "Local scheduler rejected this schedule." }, 400);
			}
			const input = routineInputSchema
				.required({ schedule: true, target: true })
				.parse(body);
			const job: JobWire = {
				created_at: new Date().toISOString(),
				enabled: input.enabled === true,
				history: [],
				id: `routine-created-${fixture.requests.filter((request) => request.method === "POST" && request.path === "/heartbeat/jobs").length}`,
				last_outcome: null,
				last_run_at: null,
				name: String(input.name ?? ""),
				require_approval: input.require_approval === true,
				schedule: input.schedule,
				target: input.target,
				updated_at: new Date().toISOString(),
			};
			const jobs = [...readStoredJobs(), job];
			writeStoredJobs(jobs);
			return json({ job });
		}
		if (url.pathname.startsWith("/heartbeat/jobs/") && method === "PUT") {
			if (fixture.failNextUpdate) {
				fixture.failNextUpdate = false;
				return json({ error: "Local scheduler rejected this update." }, 503);
			}
			const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
			const patch = routineInputSchema.parse(body);
			let updated: JobWire | undefined;
			const jobs = readStoredJobs().map((job) => {
				if (job.id !== id) {
					return job;
				}
				updated = {
					...job,
					...(isNativeText(patch.name) ? { name: patch.name } : undefined),
					...(isNativeBoolean(patch.enabled)
						? { enabled: patch.enabled }
						: undefined),
					...(isNativeBoolean(patch.require_approval)
						? { require_approval: patch.require_approval }
						: undefined),
					...(patch.schedule ? { schedule: patch.schedule } : undefined),
					...(patch.target ? { target: patch.target } : undefined),
					updated_at: new Date().toISOString(),
				};
				return updated;
			});
			if (!updated) {
				return json({ error: "Routine not found." }, 404);
			}
			writeStoredJobs(jobs);
			return json({ job: updated });
		}
		if (url.pathname.startsWith("/heartbeat/jobs/") && method === "DELETE") {
			const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
			writeStoredJobs(readStoredJobs().filter((job) => job.id !== id));
			return json({ success: true });
		}
		if (url.pathname.startsWith("/heartbeat/jobs/") && method === "POST") {
			const pathSegments = url.pathname.split("/");
			const id = decodeURIComponent(pathSegments.at(-2) ?? "");
			if (fixture.holdNextRun) {
				fixture.holdNextRun = false;
				await new Promise<void>((resolve) => {
					fixture.releaseHeldRun = resolve;
				});
				fixture.releaseHeldRun = null;
			}
			const startedAt = new Date(Date.now() - 60_000).toISOString();
			const finishedAt = new Date().toISOString();
			const jobs = readStoredJobs().map((job) =>
				job.id === id
					? {
							...job,
							history: [
								...job.history,
								{
									error: null,
									finished_at: finishedAt,
									outcome: "success" as const,
									run_id: "routine-local-run-now",
									started_at: startedAt,
								},
							],
							last_outcome: "success" as const,
							last_run_at: startedAt,
							updated_at: finishedAt,
						}
					: job
			);
			writeStoredJobs(jobs);
			return json({ run_id: "routine-local-run-now", success: true });
		}
		return json({});
	};
}

function InteractionPage() {
	const tabsValue = { openTab: () => undefined };
	return (
		<main className="min-h-screen bg-background px-6 py-10 text-foreground">
			<div className="mx-auto max-w-4xl">
				<header className="mb-8">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-widest">
						Local scheduler fixture
					</p>
					<h1 className="mt-2 font-semibold text-4xl tracking-tight">
						Agent routines
					</h1>
					<p className="mt-3 max-w-2xl text-muted-foreground">
						Manage durable agent schedules and their saved transcripts.
					</p>
				</header>
				<section className="rounded-3xl border bg-card p-5 shadow-sm">
					<TabsContext.Provider value={createTabsProofContext(tabsValue)}>
						<AgentRoutinesPanel agentId={AGENT_ID} />
					</TabsContext.Provider>
				</section>
			</div>
		</main>
	);
}

installLocalScheduler();
const proofWindow =
	/* SAFETY: This private optional __agentRoutinesInteractionsRoot holder is authored only by this module, which stores the complete native createRoot result and reuses it on later evaluation. The view preserves the browser Window and does not describe an external payload. */ window as Window & {
		__agentRoutinesInteractionsRoot?: ReturnType<typeof createRoot>;
	};
const proofRoot =
	proofWindow.__agentRoutinesInteractionsRoot ??
	createRoot(document.getElementById("root")!);
proofWindow.__agentRoutinesInteractionsRoot = proofRoot;
proofRoot.render(
	<ChatHistoryProvider>
		<InteractionPage />
	</ChatHistoryProvider>
);
