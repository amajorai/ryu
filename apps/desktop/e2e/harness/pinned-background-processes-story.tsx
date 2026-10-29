import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { PinnedSummaryPanel } from "../../src/components/panels/PinnedSummaryPanel.tsx";
import type { BackgroundProcess } from "../../src/lib/api/background-processes.ts";
import "../../src/index.css";

const TARGET = {
	token: "fixture-token",
	url: "http://background-fixture.test",
};

const INITIAL_PROCESSES: BackgroundProcess[] = [
	{
		command: "python3 -m http.server 5180",
		cwd: "/workspace/demo",
		description: "Local preview server",
		elapsed_ms: 12_000,
		exit_code: null,
		exit_signal: null,
		kind: "shell",
		label: "python3 -m http.server 5180",
		pid: 5180,
		process_id: "fixture:preview",
		producer: "@ryu/pi-shell",
		running: true,
		shell_id: "preview",
		started_at: Date.now() - 12_000,
	},
	{
		command: "bun run dev:local",
		cwd: "/workspace/demo",
		description: "Frontend dev server",
		elapsed_ms: 98_000,
		exit_code: null,
		exit_signal: null,
		kind: "shell",
		label: "bun run dev:local",
		pid: 5173,
		process_id: "fixture:frontend",
		producer: "@ryu/pi-shell",
		running: true,
		shell_id: "frontend",
		started_at: Date.now() - 98_000,
	},
];

interface FixtureWindow extends Window {
	__backgroundFixture?: {
		processes: BackgroundProcess[];
		stopRequests: string[];
	};
}

const fixture: NonNullable<FixtureWindow["__backgroundFixture"]> = {
	processes: [...INITIAL_PROCESSES],
	stopRequests: [],
};

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const url = String(input);
	if (!url.startsWith(TARGET.url)) {
		return originalFetch(input, init);
	}
	if (url.includes("/api/background/processes/") && init?.method === "POST") {
		const processId = decodeURIComponent(
			url.split("/api/background/processes/")[1]?.split("/")[0] ?? ""
		);
		fixture.stopRequests.push(processId);
		fixture.processes = fixture.processes.filter(
			(process) => process.process_id !== processId
		);
		return new Response(
			JSON.stringify({ ok: true, requested: true, process_id: processId }),
			{ headers: { "Content-Type": "application/json" }, status: 200 }
		);
	}
	if (url.includes("/api/background/processes?")) {
		return new Response(JSON.stringify({ processes: fixture.processes }), {
			headers: { "Content-Type": "application/json" },
			status: 200,
		});
	}
	return new Response(JSON.stringify({}), {
		headers: { "Content-Type": "application/json" },
		status: 200,
	});
};

/* SAFETY: This assignment publishes the complete locally typed fixture holder above; native process records and string stop requests retain their existing authored types. */ (
	window as FixtureWindow
).__backgroundFixture = fixture;

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { retry: false, staleTime: 0 },
	},
});

function Story() {
	return (
		<div className="dark min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto h-[560px] w-72">
				<PinnedSummaryPanel
					conversationId={null}
					cowork={{
						chatStatus: "ready",
						messages: [],
						runId: null,
						target: TARGET,
					}}
					folder={null}
					target={TARGET}
				/>
			</div>
			<div className="sr-only" data-testid="fixture-stop-requests">
				{fixture.stopRequests.join(",")}
			</div>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={queryClient}>
		<Story />
	</QueryClientProvider>
);

document.body.dataset.harnessReady = "1";
