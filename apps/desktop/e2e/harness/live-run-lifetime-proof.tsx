import { I18nProvider } from "@ryu/i18n/react";
import {
	QueryClient,
	QueryClientProvider,
	useQueryClient,
} from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { LiveActivityDock } from "../../src/components/live/LiveActivityDock.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import { type RunSummary, useRuns } from "../../src/hooks/useRuns.ts";
import type { RunStreamFrame } from "../../src/lib/api/runStream.ts";
import { useAgentRunLiveActivities } from "../../src/live/adapters/agent-runs.ts";
import { useContributedLiveActivities } from "../../src/live/adapters/contributed.ts";
import { useLiveActivityStore } from "../../src/store/useLiveActivityStore.ts";
import "../../src/index.css";
const contributedMode = new URLSearchParams(location.search).has("contributed");
let sourceReads = 0;
let definitions = ["First activity", "Second activity"].map((title, index) => ({
	id: `activity-${index}`,
	title,
	plugin: "com.ryu.fixture",
	spec: {
		source: {
			http: { path: "/api/ext/com.ryu.fixture/jobs", method: "GET" },
			items: "jobs",
			map: {
				id: "id",
				title: "missing",
				titleFallback: title,
				detail: "detail",
			},
		},
	},
}));
let connectionCount = 0;
let output: ReadableStreamDefaultController<Uint8Array> | null = null;
const run: RunSummary = {
	id: "proof-run",
	agent_id: null,
	branch: "main",
	created_at: 0,
	folder_path: "/workspace/reports",
	message_count: 0,
	run_status: "running",
	title: "Build report",
	updated_at: 1,
	worktree_path: null,
};
const emit = (data: RunStreamFrame) =>
	output?.enqueue(
		new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
	);
window.fetch = async (input, init) => {
	const url = String(input instanceof Request ? input.url : input);
	if (url.endsWith("/api/plugins/contributions")) {
		return Response.json({
			live_activities: contributedMode ? definitions : [],
		});
	}
	if (url.endsWith("/api/ext/com.ryu.fixture/jobs")) {
		sourceReads++;
		return Response.json({ jobs: [{ id: "job", detail: "Review queue" }] });
	}
	if (url.endsWith("/api/runs/stream")) {
		connectionCount++;
		return new Response(
			new ReadableStream({
				start(controller) {
					output = controller;
					emit({ type: "snapshot", runs: [run] });
					init?.signal?.addEventListener(
						"abort",
						() => controller.error(new DOMException("Aborted", "AbortError")),
						{ once: true }
					);
				},
			})
		);
	}
	return Response.json({});
};
Object.defineProperty(window, "Notification", {
	value: { permission: "denied" },
	configurable: true,
});
useLiveActivityStore.getState().upsert({
	id: "download:proof",
	appId: "shell",
	kind: "download",
	title: "Download assets",
	status: "running",
	detail: "Shared project assets",
	startedAt: 0,
	updatedAt: 0,
	icon: "download",
});
function Proof() {
	const client = useQueryClient();
	useContributedLiveActivities();
	const { runs } = useRuns();
	useAgentRunLiveActivities();
	return (
		<main className="min-h-screen bg-background p-10 text-foreground">
			<h1 className="font-semibold text-xl">Live activities</h1>
			<p className="mt-2 text-muted-foreground text-sm">
				Run monitor and dock ·{" "}
				<span data-testid="connections">{connectionCount}</span> shared stream ·{" "}
				{runs.length} run
			</p>
			<div className="mt-4 flex gap-3">
				<button
					onClick={() =>
						emit({ type: "run", run: { ...run, run_status: "completed" } })
					}
					type="button"
				>
					Complete run
				</button>
				<button onClick={() => emit({ type: "run", run })} type="button">
					Resume run
				</button>
			</div>
			{contributedMode && (
				<div className="mt-3 flex gap-3">
					<span data-testid="source-reads">{sourceReads}</span> source read
					<button
						onClick={() => {
							definitions = definitions.slice(1);
							void client.invalidateQueries({
								queryKey: ["plugin-contributions"],
							});
						}}
						type="button"
					>
						Remove first activity
					</button>
				</div>
			)}
			<LiveActivityDock />
		</main>
	);
}
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<I18nProvider>
			<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
				<QueryClientProvider client={new QueryClient()}>
					<EntitlementProvider>
						<TabsProvider>
							<Proof />
						</TabsProvider>
					</EntitlementProvider>
				</QueryClientProvider>
			</ThemeProvider>
		</I18nProvider>
	);
}
