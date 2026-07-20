"use client";

import { cn } from "@ryu/ui/lib/utils";
import { Reveal } from "./reveal.tsx";

interface Cell {
	has?: boolean;
	text: string;
}

const rows: { capability: string; mesa: Cell; ryu: Cell }[] = [
	{
		capability: "Category",
		mesa: { text: "Versioned filesystem" },
		ryu: { text: "End-to-end agent stack" },
	},
	{
		capability: "Versioned agent state",
		mesa: { text: "Branch + rollback", has: true },
		ryu: { text: "Checkpoints, fork, worktrees", has: true },
	},
	{
		capability: "Memory & skills",
		mesa: { text: "Versioned storage", has: true },
		ryu: { text: "Auto memory + skills registry", has: true },
	},
	{
		capability: "Human-in-the-loop",
		mesa: { text: "Approvals, pause/resume", has: true },
		ryu: { text: "Approval inbox, pause/resume", has: true },
	},
	{
		capability: "Parallel agents",
		mesa: { text: "Isolated branches", has: true },
		ryu: { text: "Teams + visual orchestration", has: true },
	},
	{
		capability: "Tool / MCP access",
		mesa: { text: "—" },
		ryu: { text: "250+ registry", has: true },
	},
	{
		capability: "Model & engine routing",
		mesa: { text: "—" },
		ryu: { text: "Any model, dynamic routing", has: true },
	},
	{
		capability: "Prompt-injection security",
		mesa: { text: "—" },
		ryu: { text: "Built-in firewall", has: true },
	},
	{
		capability: "Surfaces",
		mesa: { text: "API / mount", has: true },
		ryu: { text: "Desktop, Mobile, CLI, Bots, API", has: true },
	},
	{
		capability: "Cost controls",
		mesa: { text: "Storage tiers", has: true },
		ryu: { text: "Per-agent budgets", has: true },
	},
	{
		capability: "Access control",
		mesa: { text: "Per branch / path", has: true },
		ryu: { text: "Org / Team / User + encryption", has: true },
	},
	{
		capability: "Self-hostable",
		mesa: { text: "Yes", has: true },
		ryu: { text: "Ryu Gateway, local-first", has: true },
	},
];

function ComparisonCell({
	cell,
	emphasize,
}: {
	cell: Cell;
	emphasize?: boolean;
}) {
	const isEmpty = cell.text === "—";
	let toneClass = "text-muted-foreground";
	if (isEmpty) {
		toneClass = "text-muted-foreground/40";
	} else if (emphasize) {
		toneClass = "font-medium text-foreground";
	}
	return (
		<span className={cn("flex items-center gap-1.5 text-sm", toneClass)}>
			{cell.has && emphasize ? (
				<span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground font-bold text-[10px] text-background">
					✓
				</span>
			) : null}
			{cell.text}
		</span>
	);
}

export default function Comparison() {
	return (
		<section className="container mx-auto px-4 py-24">
			<div className="mx-auto max-w-4xl">
				<div className="mb-12 text-center">
					<h2 className="font-medium text-3xl text-foreground tracking-tight md:text-4xl">
						Mesa versions files. Ryu runs the whole stack.
					</h2>
					<p className="mx-auto mt-4 max-w-xl text-muted-foreground text-sm md:text-base">
						Mesa is a versioned filesystem for agents, the storage layer. Ryu
						gives you that versioned state and the rest of the stack: routing,
						tools, memory, security, and budgets around any agent.
					</p>
				</div>

				<div className="overflow-hidden rounded-2xl bg-muted/40">
					{/* Header */}
					<div className="grid grid-cols-3 gap-2 px-5 py-3.5">
						<span className="font-semibold text-foreground/50 text-xs uppercase tracking-wider">
							Capability
						</span>
						<span className="font-semibold text-foreground/50 text-xs uppercase tracking-wider">
							Mesa
						</span>
						<span className="flex items-center gap-1.5 font-semibold text-xs uppercase tracking-wider">
							<span className="text-foreground">Ryu</span>
							<span className="inline-flex size-4 items-center justify-center rounded-full bg-foreground font-bold text-[10px] text-background">
								✓
							</span>
						</span>
					</div>

					{/* Rows */}
					{rows.map((row, i) => (
						<Reveal delay={(i % 3) * 0.04} key={row.capability}>
							<div
								className={cn(
									"grid grid-cols-3 gap-2 px-5 py-3.5 transition-colors duration-200 hover:bg-foreground/5",
									i % 2 === 0 ? "bg-foreground/[0.02]" : "bg-transparent"
								)}
							>
								<span className="text-foreground text-sm">
									{row.capability}
								</span>
								<ComparisonCell cell={row.mesa} />
								<ComparisonCell cell={row.ryu} emphasize />
							</div>
						</Reveal>
					))}
				</div>

				<p className="mx-auto mt-6 max-w-xl text-center text-muted-foreground/60 text-xs">
					Comparison based on publicly documented Mesa capabilities. Use Mesa
					for its filesystem under Ryu, they aren't mutually exclusive.
				</p>
			</div>
		</section>
	);
}
