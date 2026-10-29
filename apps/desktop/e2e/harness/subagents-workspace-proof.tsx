import { Cancel01Icon, Robot01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { SubagentsWorkspacePanel } from "../../src/components/panels/CoworkContextPanel.tsx";
import "../../src/index.css";

const now = Date.now();

function runningTask(
	id: string,
	description: string,
	startedMinutesAgo: number
) {
	return {
		type: "tool-Task",
		toolCallId: id,
		state: "input-available",
		input: {
			description,
			prompt: `${description}. Return a concise report with supporting evidence.`,
		},
		callProviderMetadata: {
			ryu: { startedAt: now - startedMinutesAgo * 60_000 },
		},
	};
}

const messages = [
	{
		role: "assistant",
		parts: [
			runningTask("stats-flow", "Trace stats data flow", 10.8),
			runningTask("stats-shapes", "Explore stats transforms", 10.9),
			runningTask("notion-history", "Review Notion history", 22.4),
			runningTask("issue-history", "Audit issue history", 22.5),
			runningTask("chart-rendering", "Inspect chart rendering", 4.2),
			{
				type: "tool-Task",
				toolCallId: "duckdb-summary",
				state: "output-available",
				input: {
					description: "Synthesize DuckDB findings",
					prompt: "Synthesize the DuckDB findings into a concise conclusion.",
				},
				output: {
					content: [
						{
							text: "The query path and materialized views agree on the final totals.",
						},
					],
				},
				callProviderMetadata: {
					ryu: {
						startedAt: now - 17 * 60_000,
						completedAt: now - 16 * 60_000,
						durationMs: 60_000,
					},
				},
			},
		],
	},
];

function WorkspaceTab() {
	return (
		<div className="flex h-12 shrink-0 items-center border-white/10 border-b bg-background px-2 text-white">
			<div className="flex h-9 items-center gap-2 rounded-lg bg-white/[0.06] px-2.5 text-white">
				<HugeiconsIcon aria-hidden className="size-4" icon={Robot01Icon} />
				<span className="font-medium text-sm" data-testid="workspace-tab-label">
					Subagents
				</span>
				<HugeiconsIcon
					aria-hidden
					className="ml-6 size-3.5 text-white/40"
					icon={Cancel01Icon}
				/>
			</div>
			<span aria-hidden className="px-3 text-white/40 text-xl">
				+
			</span>
		</div>
	);
}

function Proof() {
	const empty = new URLSearchParams(window.location.search).has("empty");
	return (
		<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
			<main className="flex h-screen min-w-[420px] flex-col bg-background text-foreground">
				<WorkspaceTab />
				<div className="min-h-0 flex-1 overflow-hidden">
					<SubagentsWorkspacePanel messages={empty ? [] : messages} />
				</div>
			</main>
		</ThemeProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Proof />);
}
