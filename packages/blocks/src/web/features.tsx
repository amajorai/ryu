"use client";

import { cn } from "@ryu/ui/lib/utils";
import { Reveal } from "./reveal.tsx";
import { SectionTitle, sectionSubtitleClass } from "./sections.tsx";

const rows = [
	{
		feature: "Prompt Injection Protection",
		bare: "Manual",
		ryu: "Built-in firewall",
	},
	{ feature: "Model Switching", bare: "Hard-coded", ryu: "Dynamic routing" },
	{
		feature: "Tool / MCP Access",
		bare: "Weeks of setup",
		ryu: "250+ registry",
	},
	{ feature: "Long-term Memory", bare: "None", ryu: "Automatic" },
	{ feature: "Email / Inboxes", bare: "Wire up SMTP", ryu: "Agent inboxes" },
	{
		feature: "Meeting Notes",
		bare: "Paste a transcript",
		ryu: "Auto-detect + summarize",
	},
	{
		feature: "Website Monitoring",
		bare: "Cron + scraper",
		ryu: "Price / stock / uptime alerts",
	},
	{
		feature: "Voice & Image",
		bare: "Separate APIs",
		ryu: "Image, TTS, STT built-in",
	},
	{
		feature: "App Connections",
		bare: "OAuth per app",
		ryu: "Composio, managed",
	},
	{ feature: "Cost Visibility", bare: "Blind", ryu: "Per-agent budgets" },
	{
		feature: "Multi-agent Orchestration",
		bare: "Custom code",
		ryu: "Visual builder",
	},
	{
		feature: "Org Hierarchy",
		bare: "None",
		ryu: "Org / Team / User",
	},
	{ feature: "Audit Logs", bare: "None", ryu: "Full trace" },
	{ feature: "Self-hostable", bare: "N/A", ryu: "Ryu Gateway" },
];

export default function Features() {
	return (
		<section className="container mx-auto px-4 py-24">
			<div className="mx-auto max-w-4xl">
				<div className="mb-12 max-w-xl">
					<SectionTitle title="The savings come from the layer around the agent." />
					<p className={sectionSubtitleClass}>
						The win is the glue around tools, memory, security, and budgets.
					</p>
				</div>

				<div className="overflow-hidden rounded-2xl bg-muted/40">
					{/* Header */}
					<div className="grid grid-cols-3 gap-2 px-5 py-3.5">
						<span className="font-semibold text-foreground/50 text-xs uppercase tracking-wider">
							Capability
						</span>
						<span className="font-semibold text-foreground/50 text-xs uppercase tracking-wider">
							Bare agent
						</span>
						<span className="flex items-center gap-1.5 font-semibold text-xs uppercase tracking-wider">
							<span className="text-foreground">Agent + Ryu</span>
							<span className="inline-flex size-4 items-center justify-center rounded-full bg-foreground font-bold text-[10px] text-background">
								✓
							</span>
						</span>
					</div>

					{/* Rows */}
					{rows.map((row, i) => (
						<Reveal delay={(i % 3) * 0.04} key={row.feature}>
							<div
								className={cn(
									"grid grid-cols-3 gap-2 px-5 py-3.5 transition-colors duration-200 hover:bg-foreground/5",
									i % 2 === 0 ? "bg-foreground/[0.02]" : "bg-transparent"
								)}
							>
								<span className="text-foreground text-sm">{row.feature}</span>
								<span className="text-muted-foreground/70 text-sm line-through decoration-foreground/15">
									{row.bare}
								</span>
								<span className="font-medium text-foreground text-sm">
									{row.ryu}
								</span>
							</div>
						</Reveal>
					))}
				</div>
			</div>
		</section>
	);
}
