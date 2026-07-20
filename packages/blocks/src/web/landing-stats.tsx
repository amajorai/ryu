"use client";

import { cn } from "@ryu/ui/lib/utils.ts";
import type { LucideIcon } from "lucide-react";
import { Bot, Cpu, HardDrive, Plug } from "lucide-react";

const METRICS: {
	icon: LucideIcon;
	iconColor: string;
	label: string;
	value: string;
}[] = [
	{
		icon: Plug,
		iconColor: "text-emerald-500",
		value: "900k",
		label: "skills out of the box",
	},
	{
		icon: Cpu,
		iconColor: "text-blue-500",
		value: "400+",
		label: "models · one subscription",
	},
	{
		icon: Bot,
		iconColor: "text-violet-500",
		value: "30+",
		label: "agents including Claude Code, Cursor, Codex & more",
	},
	{
		icon: HardDrive,
		iconColor: "text-amber-500",
		value: "2.8M+",
		label: "local models on Hugging Face",
	},
];

const metricCardClass =
	"group relative flex cursor-default flex-col gap-1 overflow-hidden rounded-2xl bg-gradient-to-b from-muted to-muted/60 px-4 py-4 text-foreground shadow-[inset_0_1px_0_0.5px_rgba(0,0,0,0.08),0px_0px_0px_1px_rgba(0,0,0,0),0px_1px_2px_-1px_rgba(0,0,0,0.08),0px_2px_4px_0px_rgba(0,0,0,0.06)] transition-all duration-300 ease-out dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.15)] sm:flex-row sm:items-center sm:gap-4 sm:px-5 sm:py-3.5";

export default function LandingStats() {
	return (
		<section className="container mx-auto px-4">
			<div className="mx-auto max-w-6xl">
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
					{METRICS.map((metric) => {
						const Icon = metric.icon;
						return (
							<div className={metricCardClass} key={metric.label}>
								<Icon
									className={cn(
										"size-6 shrink-0 transition-transform duration-300 group-hover:-rotate-3 group-hover:scale-110",
										metric.iconColor
									)}
									strokeWidth={1.5}
								/>
								<div>
									<p className="font-semibold text-2xl tracking-tight">
										{metric.value}
									</p>
									<p className="text-muted-foreground text-sm">
										{metric.label}
									</p>
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</section>
	);
}
