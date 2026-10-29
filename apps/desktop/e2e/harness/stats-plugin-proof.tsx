import { StatsFooter } from "@ryu/blocks/desktop/agent-elements/stats-footer.tsx";
import type {
	StatsMessage,
	StatsUsageSnapshot,
} from "@ryu/blocks/desktop/agent-elements/stats-model.ts";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const NOW = Date.now();

const DEMO_MESSAGES: (StatsMessage & { id: string })[] = [
	{
		id: "stats-user-1",
		parts: [
			{
				text: "Compare the local model's context and cache behavior.",
				type: "text",
			},
		],
		role: "user",
	},
	{
		id: "stats-assistant-1",
		parts: [
			{ toolCallId: "tool-1", type: "tool-call" },
			{ output: "inspected", toolCallId: "tool-1", type: "tool-result" },
			{
				data: {
					cacheWriteTokens: 160,
					cachedTokens: 1200,
					completionTokens: 900,
					cost: { amount: 0.041, currency: "USD" },
					durationMs: 4500,
					observedAt: NOW - 115_000,
					promptTokens: 1800,
					totalTokens: 2700,
				},
				type: "data-ryu-stats",
			},
		],
		role: "assistant",
	},
	{
		id: "stats-compaction",
		parts: [
			{
				data: { postTokens: 18_000, preTokens: 120_000, trigger: "auto" },
				type: "compact_boundary",
			},
		],
		role: "assistant",
	},
	{
		id: "stats-user-2",
		parts: [{ text: "Now summarize the active session totals.", type: "text" }],
		role: "user",
	},
	{
		id: "stats-assistant-2",
		parts: [
			{ toolCallId: "tool-2", type: "tool-call" },
			{ output: "summarized", toolCallId: "tool-2", type: "tool-result" },
			{ toolCallId: "tool-3", type: "tool-call" },
			{ output: "done", toolCallId: "tool-3", type: "tool-result" },
			{
				data: {
					cacheWriteTokens: 80,
					cachedTokens: 800,
					completionTokens: 500,
					context_window: {
						context_window_size: 1_000_000,
						current_usage: { used: 42_000 },
					},
					cost: { amount: 0.087, currency: "USD" },
					durationMs: 3000,
					observedAt: NOW - 35_000,
					promptTokens: 1450,
					totalTokens: 1950,
				},
				type: "data-ryu-stats",
			},
		],
		role: "assistant",
	},
];

const USAGE: StatsUsageSnapshot = {
	available: true,
	extraUsageUsd: null,
	meters: [
		{
			expiresAt: [],
			label: "Extra usage",
			resetsAt: new Date(NOW + 18 * 60 * 60 * 1000).toISOString(),
			values: [
				{ currency: "EUR", kind: "dollars", number: 3.25, unit: "spent" },
				{ currency: "EUR", kind: "dollars", number: 10, unit: "cap" },
			],
		},
	],
	windows: [
		{
			label: "Session",
			model: null,
			resetsAt: new Date(NOW + 2.5 * 60 * 60 * 1000).toISOString(),
			usedPercent: 34,
			windowSeconds: 18_000,
		},
		{
			label: "Weekly",
			model: null,
			resetsAt: new Date(NOW + 4.5 * 24 * 60 * 60 * 1000).toISOString(),
			usedPercent: 61,
			windowSeconds: 604_800,
		},
		{
			label: "Sonnet",
			model: "Sonnet",
			resetsAt: null,
			usedPercent: 42,
			windowSeconds: 604_800,
		},
		{
			label: "Opus",
			model: "Opus",
			resetsAt: null,
			usedPercent: 18,
			windowSeconds: 604_800,
		},
		{
			label: "Fable",
			model: "Fable",
			resetsAt: null,
			usedPercent: 7,
			windowSeconds: 604_800,
		},
	],
};

function StatsPluginProof() {
	return (
		<main className="min-h-screen bg-background px-10 py-12 text-foreground">
			<div className="mx-auto max-w-[1180px]">
				<header className="mb-8 flex items-start justify-between gap-8">
					<div>
						<p className="type-caption mb-3 font-semibold text-primary/80 uppercase tracking-section">
							RYU · PLUGIN PROOF
						</p>
						<h1 className="font-semibold text-4xl text-foreground tracking-tight">
							Session stats, provider-neutral.
						</h1>
						<p className="mt-3 max-w-2xl text-base text-muted-foreground leading-7">
							The extracted <span className="text-foreground">@ryu/stats</span>{" "}
							chat contribution rolls up turns, steps, tokens, prompt-cache
							activity, throughput, context, compaction, cost, and provider
							usage in one current-session surface.
						</p>
					</div>
					<div className="type-caption rounded-full border border-success/30 bg-success/10 px-4 py-2 font-semibold text-success uppercase tracking-wider">
						Rendered product proof
					</div>
				</header>

				<section className="rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20">
					<div className="mb-5 flex items-center justify-between gap-4 border-border/70 border-b pb-5">
						<div>
							<p className="type-compact font-semibold text-muted-foreground uppercase tracking-label">
								Current assistant turn
							</p>
							<h2 className="mt-1 font-medium text-foreground text-lg">
								Local model · Claude [1m] context hint
							</h2>
						</div>
						<div className="text-right text-muted-foreground text-xs">
							<p>session 2 turns · 3 tool steps</p>
							<p className="mt-1 text-primary/80">
								Hover the stats strip for the full breakdown
							</p>
						</div>
					</div>
					<div
						className="rounded-xl border border-border/70 bg-card px-5 py-4"
						data-testid="stats-plugin-proof"
					>
						<StatsFooter
							contextSize={200_000}
							conversationMessages={DEMO_MESSAGES}
							isMainChainActive={false}
							modelName="claude-code-[1m]"
							usage={USAGE}
						/>
					</div>
				</section>

				<div className="mt-6 grid gap-4 md:grid-cols-3">
					{[
						[
							"Providers",
							"ACP · BYOK · Ryu · local",
							"same normalized transcript contract",
						],
						[
							"Cache",
							"read · write · hit rate · timer",
							"latest turn or cumulative session",
						],
						[
							"Context",
							"window · usable % · compaction",
							"reported size before fallback",
						],
					].map(([title, value, detail]) => (
						<div
							className="rounded-xl border border-border bg-card/60 p-4"
							key={title}
						>
							<p className="type-compact font-semibold text-muted-foreground uppercase tracking-(--tracking-section)">
								{title}
							</p>
							<p className="mt-2 font-medium text-foreground text-sm">
								{value}
							</p>
							<p className="mt-1 text-muted-foreground text-xs">{detail}</p>
						</div>
					))}
				</div>
			</div>
		</main>
	);
}

document.documentElement.classList.add("dark");
document.body.className = "m-0 min-w-[1100px] bg-background";
const proofRoot = document.getElementById("root");
if (!proofRoot) {
	throw new Error("stats proof root missing");
}
createRoot(proofRoot).render(<StatsPluginProof />);
