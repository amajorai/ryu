"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { copyMarker as t } from "./copy-marker.ts";
import { Reveal } from "./reveal.tsx";
import { SectionTitle, sectionSubtitleClass } from "./sections.tsx";

const rows = [
	{
		feature: t("Prompt Injection Protection"),
		bare: t("Manual"),
		ryu: t("Built-in firewall"),
	},
	{
		feature: t("Model Switching"),
		bare: t("Hard-coded"),
		ryu: t("Dynamic routing"),
	},
	{
		feature: t("Tool / MCP Access"),
		bare: t("Weeks of setup"),
		ryu: t("Installed and granted tools"),
	},
	{ feature: t("Long-term Memory"), bare: t("None"), ryu: t("Automatic") },
	{
		feature: t("Email / Inboxes"),
		bare: t("Wire up SMTP"),
		ryu: t("Agent inboxes"),
	},
	{
		feature: t("Meeting Notes"),
		bare: t("Paste a transcript"),
		ryu: t("Auto-detect + summarize"),
	},
	{
		feature: t("Website Monitoring"),
		bare: t("Cron + scraper"),
		ryu: t("Price / stock / uptime alerts"),
	},
	{
		feature: t("Voice & Image"),
		bare: t("Separate APIs"),
		ryu: t("Image, Audio, Voice Recognition built-in"),
	},
	{
		feature: t("App Connections"),
		bare: t("OAuth per app"),
		ryu: t("Composio, managed"),
	},
	{
		feature: t("Cost Visibility"),
		bare: t("Blind"),
		ryu: t("Per-agent budgets"),
	},
	{
		feature: t("Multi-agent Orchestration"),
		bare: t("Custom code"),
		ryu: t("Visual builder"),
	},
	{
		feature: t("Org Hierarchy"),
		bare: t("None"),
		ryu: t("Org / Team / User"),
	},
	{ feature: t("Audit Logs"), bare: t("None"), ryu: t("Full trace") },
	{ feature: t("Self-hostable"), bare: t("N/A"), ryu: t("Ryu Gateway") },
];

export default function Features() {
	const tl = useLiteralMessages();
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
						<span className="font-medium text-foreground/50 text-xs uppercase tracking-wider">
							Capability
						</span>
						<span className="font-medium text-foreground/50 text-xs uppercase tracking-wider">
							Bare agent
						</span>
						<span className="flex items-center gap-1.5 font-medium text-xs uppercase tracking-wider">
							<span className="text-foreground">Agent + Ryu</span>
							<span className="type-compact inline-flex size-4 items-center justify-center rounded-full bg-foreground font-medium text-background">
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
								<span className="text-foreground text-sm">
									{tl(row.feature)}
								</span>
								<span className="text-muted-foreground/70 text-sm line-through decoration-foreground/15">
									{tl(row.bare)}
								</span>
								<span className="font-medium text-foreground text-sm">
									{tl(row.ryu)}
								</span>
							</div>
						</Reveal>
					))}
				</div>
			</div>
		</section>
	);
}
