"use client";

import { useEffect, useState } from "react";
import { landingSurfaceCardFlexXlClass } from "./landing-card-tones.ts";
import { SectionTitle, sectionSubtitleClass } from "./sections.tsx";

function CollaborationViz() {
	const [step, setStep] = useState(0);
	const tasks = ["Research", "Draft", "Review", "Execute", "Report"];

	useEffect(() => {
		const t = setInterval(() => setStep((s) => (s + 1) % tasks.length), 1200);
		return () => clearInterval(t);
	}, [tasks.length]);

	return (
		<div className="relative flex flex-1 flex-col gap-4">
			{/* Human + Agent nodes */}
			<div className="flex items-center justify-between gap-3">
				<div className="flex flex-col items-center gap-1.5">
					<div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted/60">
						<svg
							aria-hidden="true"
							className="h-5 w-5 text-foreground/60"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={1.5}
							/>
						</svg>
					</div>
					<span className="text-foreground/40 text-xs">Human</span>
				</div>

				{/* Task flowing between them */}
				<div className="relative flex flex-1 flex-col items-center gap-1">
					<div className="relative flex w-full items-center">
						<div className="h-px w-full bg-border" />
						<div
							className="absolute h-1.5 w-1.5 animate-flow-right rounded-full bg-foreground/50"
							style={{ left: "20%" }}
						/>
						<div
							className="absolute h-1.5 w-1.5 animate-flow-right rounded-full bg-foreground/50"
							style={{ left: "20%", animationDelay: "0.4s" }}
						/>
					</div>
					<span className="rounded-full bg-muted/60 px-2 py-0.5 text-foreground/60 text-xs transition-all duration-300">
						{tasks[step]}
					</span>
					<div className="relative flex w-full items-center">
						<div className="h-px w-full bg-border" />
						<div
							className="absolute h-1.5 w-1.5 animate-flow-left rounded-full bg-foreground/30"
							style={{ right: "20%" }}
						/>
						<div
							className="absolute h-1.5 w-1.5 animate-flow-left rounded-full bg-foreground/30"
							style={{ right: "20%", animationDelay: "0.4s" }}
						/>
					</div>
				</div>

				<div className="flex flex-col items-center gap-1.5">
					<div className="flex h-10 w-10 items-center justify-center rounded-full bg-foreground/10">
						<span className="font-bold text-foreground/60 text-xs">AI</span>
					</div>
					<span className="text-foreground/40 text-xs">Agent</span>
				</div>
			</div>

			{/* Output badge */}
			<div className="flex items-center justify-center gap-2">
				<div className="animate-node-pulse rounded-full bg-muted/40 px-3 py-1 text-foreground/50 text-xs">
					Together → 10× output
				</div>
			</div>
		</div>
	);
}

function InfraViz() {
	const infraLayers = [
		"Deployment",
		"Scaling",
		"Monitoring",
		"Rate Limits",
		"Auth",
		"Retries",
	];

	return (
		<div className="flex flex-1 flex-col gap-3">
			{/* User-facing layer */}
			<div className="rounded-lg bg-foreground px-3 py-2 text-center">
				<span className="font-semibold text-background text-xs tracking-wide">
					Your Agent Code
				</span>
			</div>

			<div className="flex items-center justify-center gap-1.5">
				<div className="h-px flex-1 bg-border/50" />
				<span className="text-foreground/30 text-xs">Ryu handles</span>
				<div className="h-px flex-1 bg-border/50" />
			</div>

			{/* Hidden infra stack */}
			<div className="rounded-lg bg-foreground/[0.03] p-2">
				<div className="flex flex-wrap justify-center gap-1.5">
					{infraLayers.map((layer, i) => (
						<span
							className="animate-tool-float rounded bg-muted/40 px-2 py-0.5 text-foreground/35 text-xs"
							key={layer}
							style={{ animationDelay: `${i * 0.25}s` }}
						>
							{layer}
						</span>
					))}
				</div>
			</div>
		</div>
	);
}

function ScaleViz() {
	const tiers = [
		{ label: "Solo developer", count: 1 },
		{ label: "Small team", count: 3 },
		{ label: "Enterprise", count: 7 },
	];
	const [tier, setTier] = useState(0);

	useEffect(() => {
		const t = setInterval(() => setTier((s) => (s + 1) % tiers.length), 1800);
		return () => clearInterval(t);
	}, [tiers.length]);

	const current = tiers[tier];

	return (
		<div className="flex flex-1 flex-col justify-between gap-3">
			<div className="flex gap-1.5">
				{tiers.map((t, i) => (
					<button
						className={`flex-1 rounded px-1.5 py-1 text-xs transition-all ${
							i === tier
								? "bg-foreground/10 text-foreground/80"
								: "bg-muted/30 text-foreground/30"
						}`}
						key={t.label}
						onClick={() => setTier(i)}
						type="button"
					>
						{i === 0 ? "Solo" : i === 1 ? "Team" : "Org"}
					</button>
				))}
			</div>

			<div className="flex flex-wrap gap-1.5">
				{Array.from({ length: current.count }).map((_, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: static viz
					<div
						className="flex h-8 w-8 animate-node-pulse items-center justify-center rounded-full bg-foreground/8"
						key={i}
						style={{ animationDelay: `${i * 0.2}s` }}
					>
						<svg
							aria-hidden="true"
							className="h-4 w-4 text-foreground/50"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={1.5}
							/>
						</svg>
					</div>
				))}
			</div>

			<p className="text-foreground/40 text-xs">{current.label}</p>
		</div>
	);
}

const panels = [
	{
		viz: <CollaborationViz />,
		title: "Helping humans, not replacing them.",
		description:
			"Our mission is to bring reliable agents to the workforce - amplifying what people can do, not taking their seat at the table.",
	},
	{
		viz: <InfraViz />,
		title: "Deploying agents doesn't need to be hard.",
		description:
			"We manage the infrastructure - deployment, scaling, monitoring, retries. You just write your agent and ship it.",
	},
	{
		viz: <ScaleViz />,
		title: "Built for every scale.",
		description:
			"Whether you're a solo developer or a large organisation, Ryu grows with you - no rearchitecting required.",
	},
];

export default function Mission() {
	return (
		<div className="container mx-auto px-4">
			<div className="mx-auto max-w-4xl">
				<div className="mb-10">
					<SectionTitle
						className="max-w-xl"
						title="Built for both humans and agents to collaborate."
					/>
					<p className={sectionSubtitleClass}>
						The future of work is people and agents side by side, not competing.
					</p>
				</div>

				<div className="grid grid-cols-1 gap-3 md:grid-cols-3">
					{panels.map((panel) => (
						<div className={landingSurfaceCardFlexXlClass} key={panel.title}>
							{panel.viz}
							<div>
								<h3 className="mb-1 font-semibold text-foreground text-sm">
									{panel.title}
								</h3>
								<p className="text-muted-foreground text-xs">
									{panel.description}
								</p>
							</div>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
