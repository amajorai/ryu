import { buttonVariants } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import { Code2, Eye, Github, Server, ShieldCheck } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { DOCS_URL } from "./data/resources.tsx";
import { GITHUB_REPO } from "./download.tsx";
import {
	landingSurfaceCardClass,
	landingSurfaceCardFlexClass,
} from "./landing-card-tones.ts";
import { Reveal } from "./reveal.tsx";
import { SectionHeading } from "./sections.tsx";

const PILLARS: {
	description: string;
	Icon: LucideIcon;
	title: string;
}[] = [
	{
		Icon: Code2,
		title: "Open-core foundation",
		description:
			"Core and Gateway are open source and self-hostable — the orchestration engine and LLM control layer you can read, fork, and deploy yourself.",
	},
	{
		Icon: Server,
		title: "Self-host anywhere",
		description:
			"Run Core + Gateway on your laptop, home server, or VPC. Point any OpenAI-compatible client at your gateway — no Ryu Cloud required.",
	},
	{
		Icon: Eye,
		title: "Transparent and verifiable",
		description:
			"Inspect routing, firewall rules, budgets, and tool allowlists in code. Every model call and tool run is audited — no black boxes.",
	},
	{
		Icon: ShieldCheck,
		title: "Zero lock-in",
		description:
			"BYO agent, key, and subscription. Swap models, engines, and strategies through one config — nothing hardcoded, everything swappable.",
	},
];

const OPEN_UNITS = [
	{ name: "Core", license: "Apache-2.0" },
	{ name: "Gateway", license: "AGPL-3.0" },
	{ name: "SDK", license: "Apache-2.0" },
	{ name: "CLI", license: "Apache-2.0" },
] as const;

function OpenStackViz() {
	return (
		<div className={cn(landingSurfaceCardClass, "rounded-3xl p-4 md:p-5")}>
			<p className="font-medium text-[11px] text-foreground/50 uppercase tracking-widest">
				Open & self-hostable
			</p>
			<div className="mt-5 space-y-2">
				{OPEN_UNITS.map((unit, i) => (
					<Reveal delay={i * 0.06} key={unit.name}>
						<div className="flex items-center justify-between rounded-xl bg-foreground/5 px-4 py-3">
							<span className="font-medium text-foreground text-sm">
								{unit.name}
							</span>
							<span className="font-mono text-foreground/50 text-xs">
								{unit.license}
							</span>
						</div>
					</Reveal>
				))}
			</div>
			<p className="mt-5 text-foreground/45 text-xs leading-relaxed">
				Desktop, web, and cloud are the commercial UX layer — the runtime you
				audit and extend stays open.
			</p>
		</div>
	);
}

export default function OpenSource() {
	return (
		<section className="container mx-auto px-4 py-16 md:py-24">
			<div className="mx-auto max-w-6xl">
				<SectionHeading
					eyebrow="Open agent system"
					subtitle="Harness, model routing, runtime, and governance around any engine — the orchestration and control layer is open source. Self-host it, read every line, and verify what your agents are allowed to do."
					title="An open agent system. Yours to run."
				/>

				<div className="grid items-start gap-10 lg:grid-cols-2 lg:gap-16">
					<Reveal>
						<OpenStackViz />
					</Reveal>

					<div className="grid gap-3 sm:grid-cols-2">
						{PILLARS.map((pillar, i) => {
							const { Icon } = pillar;
							return (
								<Reveal delay={(i % 2) * 0.08} key={pillar.title}>
									<div className={landingSurfaceCardFlexClass}>
										<Icon
											className="size-5 text-foreground"
											strokeWidth={1.75}
										/>
										<div>
											<h3 className="font-medium text-foreground text-sm tracking-tight">
												{pillar.title}
											</h3>
											<p className="mt-1.5 text-muted-foreground text-xs leading-relaxed">
												{pillar.description}
											</p>
										</div>
									</div>
								</Reveal>
							);
						})}
					</div>
				</div>

				<Reveal delay={0.12}>
					<div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
						<Link
							className={cn(buttonVariants({ size: "lg" }))}
							href={GITHUB_REPO}
							rel="noopener noreferrer"
							target="_blank"
						>
							<Github className="size-4" strokeWidth={1.5} />
							View on GitHub
						</Link>
						<Link
							className={cn(buttonVariants({ size: "lg", variant: "ghost" }))}
							href={DOCS_URL as Route}
							rel="noopener noreferrer"
							target="_blank"
						>
							Self-hosting docs
						</Link>
					</div>
				</Reveal>
			</div>
		</section>
	);
}
