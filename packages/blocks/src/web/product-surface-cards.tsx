"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { AgentsVisual, GatewayVisual, MarketplaceVisual } from "./visuals.tsx";

const SURFACES = [
	{
		id: "apps",
		Visual: MarketplaceVisual,
		label: "Ryu Apps",
		href: "/products/apps",
		description:
			"Official app surfaces for publishing, monitoring, production, and knowledge work.",
	},
	{
		id: "bot",
		Visual: AgentsVisual,
		label: "Bot",
		href: "/bot",
		description: "Ask an agent to handle a task through chat.",
	},
	{
		id: "console",
		Visual: GatewayVisual,
		label: "Agent",
		href: "/agent",
		description: "Manage agents, connected tools, permissions, and usage.",
	},
] as const;

export function ProductSurfaceCards({ className }: { className?: string }) {
	const tl = useLiteralMessages();
	return (
		<div className={cn("grid gap-10 md:grid-cols-3", className)}>
			{SURFACES.map((surface) => (
				<Link
					className="group block py-2 outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
					data-testid={`realm-card-${surface.id}`}
					href={surface.href}
					key={surface.id}
				>
					<div
						className="mb-6 flex min-h-64 items-center overflow-hidden bg-muted/40 p-5"
						data-product-visual
					>
						<div
							aria-label={tl("{label} example", { label: surface.label })}
							className="w-full min-w-0"
						>
							<surface.Visual />
						</div>
					</div>
					<div className="flex items-center justify-between gap-4">
						<h3 className="font-heading font-medium text-xl tracking-tight group-hover:underline group-hover:underline-offset-4">
							{surface.label}
						</h3>
						<ArrowUpRight
							aria-hidden="true"
							className="size-4 text-muted-foreground"
						/>
					</div>
					<p className="mt-3 max-w-xs text-muted-foreground text-sm leading-relaxed">
						{surface.description}
					</p>
				</Link>
			))}
		</div>
	);
}
