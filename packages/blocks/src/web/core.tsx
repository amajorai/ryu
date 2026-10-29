"use client";

import { SquareLock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import styles from "./core.module.css";
import { landingSurfaceCardFlexXlClass } from "./landing-card-tones.ts";
import { SectionTitle } from "./section-title.tsx";

interface CoreVariables extends CSSProperties {
	"--core-delay"?: string;
	"--core-duration"?: string;
	"--core-height"?: string;
	"--core-left"?: string;
	"--core-top"?: string;
	"--core-width"?: string;
}

function SecurityViz() {
	const threats = [
		{ row: 0, col: 2, delay: "0s" },
		{ row: 1, col: 5, delay: "0.8s" },
		{ row: 2, col: 8, delay: "1.6s" },
		{ row: 0, col: 11, delay: "2.4s" },
	];
	return (
		<div className="relative flex flex-1 flex-col justify-center gap-4">
			<div className="relative">
				<div className="grid grid-cols-12 justify-items-center gap-y-3">
					{Array.from({ length: 36 }).map((_, i) => {
						const threat = threats.find((t) => t.row * 12 + t.col === i);
						return (
							<div
								className={cn(
									`h-2 w-2 rounded-full ${threat ? `${styles.threatResolve} bg-destructive` : "bg-foreground/20"}`,
									styles.variables
								)}
								key={i}
								style={
									threat
										? ({
												"--core-delay": threat.delay,
											} satisfies CoreVariables as CoreVariables)
										: undefined
								}
							/>
						);
					})}
				</div>
				<div
					className={`absolute inset-x-0 top-0 h-px ${styles.scanSweep} bg-foreground/30`}
				/>
			</div>
			<p
				className={`${styles.threatResolve} text-foreground/30 text-xs tracking-widest`}
			>
				SCANNING
			</p>
		</div>
	);
}

function RouterViz() {
	return (
		<div className="flex flex-1 flex-col items-center gap-2">
			<div className="flex-shrink-0 rounded-md bg-foreground/8 px-2 py-1 text-foreground/70 text-xs">
				Your Code
			</div>
			<div className="relative flex min-h-6 flex-1 flex-col items-center">
				<div className="h-full w-px bg-border" />
				{[0, 0.3, 0.6].map((delay, i) => (
					<div
						className={cn(
							`absolute h-1.5 w-1.5 ${styles.flowDown} rounded-full bg-foreground/60`,
							styles.variables
						)}
						key={i}
						style={
							{
								"--core-delay": `${delay}s`,
								"--core-top": "30%",
							} satisfies CoreVariables as CoreVariables
						}
					/>
				))}
			</div>
			<div
				className={`flex-shrink-0 ${styles.nodePulse} rounded-full bg-foreground px-3 py-1 font-medium text-background text-xs`}
			>
				RYU
			</div>
			<div className="relative flex min-h-6 flex-1 flex-col items-center">
				<div className="h-full w-px bg-border" />
				{[0.2, 0.5, 0.8].map((delay, i) => (
					<div
						className={cn(
							`absolute h-1.5 w-1.5 ${styles.flowDown} rounded-full bg-foreground/60`,
							styles.variables
						)}
						key={i}
						style={
							{
								"--core-delay": `${delay}s`,
								"--core-top": "50%",
							} satisfies CoreVariables as CoreVariables
						}
					/>
				))}
			</div>
			<div className="flex flex-shrink-0 flex-wrap justify-center gap-1">
				{["GPT-4o", "Claude", "Llama 3"].map((m) => (
					<div
						className="rounded bg-foreground/8 px-1.5 py-0.5 text-foreground/70 text-xs"
						key={m}
					>
						{m}
					</div>
				))}
			</div>
		</div>
	);
}

function McpViz() {
	const tools = ["GitHub", "Slack", "Postgres", "Browser", "Email", "Cal"];
	return (
		<div className="flex flex-1 flex-wrap gap-2">
			{tools.map((tool, i) => (
				<span
					className={cn(
						`inline-flex ${styles.toolFloat} items-center rounded-full bg-foreground/8 px-2.5 py-1 text-foreground/70 text-xs`,
						styles.variables
					)}
					key={tool}
					style={
						{
							"--core-delay": `${i * 0.33}s`,
						} satisfies CoreVariables as CoreVariables
					}
				>
					{tool}
				</span>
			))}
		</div>
	);
}

function MemoryViz() {
	const durations = ["3s", "4s", "5s", "3.5s", "4.5s"];
	return (
		<div className="flex flex-1 gap-6">
			<div className="flex flex-col gap-2">
				<div className="flex h-8 w-8 items-center justify-center rounded bg-foreground/8">
					<svg
						aria-hidden="true"
						className="h-4 w-4 text-foreground/50"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
						/>
					</svg>
				</div>
				{[0, 0.4, 0.8].map((delay, i) => (
					<div
						className={cn(
							`h-1.5 ${styles.chunkAppear} rounded-full bg-foreground/20`,
							styles.variables
						)}
						key={i}
						style={
							{
								"--core-delay": `${delay}s`,
								"--core-width": i === 0 ? "4rem" : i === 1 ? "3rem" : "3.5rem",
							} satisfies CoreVariables as CoreVariables
						}
					/>
				))}
			</div>
			<div className="relative flex flex-1 items-center justify-center">
				<div className="h-2 w-2 rounded-full bg-foreground/60" />
				{durations.map((dur, i) => (
					<div
						className={cn(
							`absolute h-1.5 w-1.5 ${styles.vecOrbit} rounded-full bg-foreground/40`,
							styles.variables
						)}
						key={i}
						style={
							{
								"--core-duration": dur,
								"--core-delay": `${i * 0.5}s`,
							} satisfies CoreVariables as CoreVariables
						}
					/>
				))}
			</div>
		</div>
	);
}

function CostViz() {
	const [tokens, setTokens] = useState(0);
	useEffect(() => {
		const interval = setInterval(() => {
			setTokens((prev) => (prev >= 142_500 ? 0 : prev + 4750));
		}, 100);
		return () => clearInterval(interval);
	}, []);

	return (
		<div className="flex flex-1 flex-col justify-center gap-3">
			<div className="flex items-baseline justify-between">
				<span className="text-foreground/50 text-xs tracking-wider">
					BUDGET
				</span>
				<span className="font-medium text-foreground text-sm">$50.00</span>
			</div>
			<div className="relative h-2 overflow-hidden rounded-full bg-muted/50">
				<div
					className={`h-full ${styles.budgetFill} rounded-full bg-foreground/70`}
				/>
				<div
					className={cn(
						"absolute top-0 h-full w-px bg-destructive/70",
						styles.variables
					)}
					style={
						{ "--core-left": "78%" } satisfies CoreVariables as CoreVariables
					}
				/>
			</div>
			<div className="flex justify-between text-muted-foreground/50 text-xs">
				<span>0</span>
				<span>Limit</span>
			</div>
			<p className="text-foreground/60 text-sm tabular-nums">
				<span className="font-medium text-foreground">
					{formatCount(tokens)}
				</span>{" "}
				tokens used
			</p>
		</div>
	);
}

function VaultViz() {
	const rows = ["enc:v1:9f2a4c…", "enc:v1:7c10be…", "enc:v1:b4e8d1…"];
	return (
		<div className="relative flex flex-1 items-center gap-4">
			<HugeiconsIcon
				className={`h-5 w-5 shrink-0 ${styles.nodePulse} text-foreground`}
				icon={SquareLock01Icon}
			/>
			<div className="flex flex-1 flex-col gap-2">
				{rows.map((row, i) => (
					<div
						className={cn(
							`flex ${styles.chunkAppear} items-center gap-2`,
							styles.variables
						)}
						key={row}
						style={
							{
								"--core-delay": `${i * 0.4}s`,
							} satisfies CoreVariables as CoreVariables
						}
					>
						<span className="h-1.5 w-1.5 rounded-full bg-foreground/60" />
						<span className="font-mono text-foreground/50 text-xs">{row}</span>
					</div>
				))}
			</div>
		</div>
	);
}

function WorkflowViz() {
	const nodes = ["Trigger", "Route", "Agent A", "Agent B", "Report"];
	return (
		<div className="relative flex flex-1 items-center">
			<svg
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 h-full w-full"
				fill="none"
			>
				{[0, 1, 2, 3].map((i) => (
					<line
						className={cn(`${styles.edgeTrace}`, styles.variables)}
						key={`edge-${i}`}
						stroke="currentColor"
						strokeDasharray="80"
						strokeOpacity="0.3"
						strokeWidth="1"
						style={
							{
								"--core-delay": `${i * 0.5}s`,
							} satisfies CoreVariables as CoreVariables
						}
						x1={`${(i / 4) * 100 + 10}%`}
						x2={`${((i + 1) / 4) * 100}%`}
						y1="50%"
						y2="50%"
					/>
				))}
			</svg>
			<div className="flex w-full items-center gap-1">
				{nodes.map((node, i) => (
					<div
						className={cn(
							`type-compact min-w-0 flex-1 ${styles.nodePulse} truncate rounded-md bg-foreground/8 px-1.5 py-1 text-center text-foreground/80`,
							styles.variables
						)}
						key={node}
						style={
							{
								"--core-delay": `${i * 0.5}s`,
							} satisfies CoreVariables as CoreVariables
						}
					>
						{node}
					</div>
				))}
			</div>
		</div>
	);
}

function DlpViz() {
	const fields = [
		{ label: "email", value: "[REDACTED]", delay: "0s" },
		{ label: "phone", value: "[REDACTED]", delay: "0.3s" },
		{ label: "ssn", value: "[REDACTED]", delay: "0.6s" },
	];
	return (
		<div className="flex flex-1 flex-col justify-center gap-2.5">
			{fields.map((field) => (
				<div
					className={cn(
						`flex ${styles.chunkAppear} items-center justify-between gap-3 rounded-md bg-foreground/5 px-3 py-2 font-mono text-xs`,
						styles.variables
					)}
					key={field.label}
					style={
						{
							"--core-delay": field.delay,
						} satisfies CoreVariables as CoreVariables
					}
				>
					<span className="text-foreground/40">{field.label}</span>
					<span className="text-foreground/70">{field.value}</span>
				</div>
			))}
		</div>
	);
}

function AuditViz() {
	const events = [
		"chat.completion → gpt-4o",
		"tool.exec → github.search",
		"budget.check → pass",
	];
	return (
		<div className="flex flex-1 flex-col justify-center gap-2">
			{events.map((event, i) => (
				<div
					className={cn(
						`flex ${styles.chunkAppear} items-center gap-2`,
						styles.variables
					)}
					key={event}
					style={
						{
							"--core-delay": `${i * 0.35}s`,
						} satisfies CoreVariables as CoreVariables
					}
				>
					<span className="h-1.5 w-1.5 rounded-full bg-foreground/60" />
					<span className="truncate font-mono text-foreground/50 text-xs">
						{event}
					</span>
				</div>
			))}
		</div>
	);
}

function CacheViz() {
	const [hit, setHit] = useState(false);
	useEffect(() => {
		const interval = setInterval(() => {
			setHit((prev) => !prev);
		}, 1800);
		return () => clearInterval(interval);
	}, []);
	return (
		<div className="flex flex-1 flex-col justify-center gap-3">
			<div className="flex items-center justify-between text-xs">
				<span className="text-foreground/50 tracking-wider">
					SEMANTIC CACHE
				</span>
				<span className="font-medium text-foreground">
					{hit ? "HIT" : "MISS"}
				</span>
			</div>
			<div className="grid grid-cols-4 gap-1.5">
				{Array.from({ length: 8 }).map((_, i) => (
					<div
						className={`h-6 rounded-sm transition-colors duration-500 ${hit && i < 5 ? "bg-foreground/50" : "bg-foreground/15"}`}
						key={i}
					/>
				))}
			</div>
		</div>
	);
}

function MediaViz() {
	const tiles = Array.from({ length: 16 });
	const bars = [8, 14, 20, 11, 17, 9, 15, 12];
	return (
		<div className="flex flex-1 items-center gap-5">
			<div className="grid grid-cols-4 gap-1">
				{tiles.map((_, i) => (
					<div
						className={cn(
							`h-3 w-3 ${styles.chunkAppear} rounded-sm bg-foreground/25`,
							styles.variables
						)}
						key={i}
						style={
							{
								"--core-delay": `${i * 0.06}s`,
							} satisfies CoreVariables as CoreVariables
						}
					/>
				))}
			</div>
			<div className="flex flex-1 items-center gap-0.5">
				{bars.map((h, i) => (
					<span
						className={cn(
							`w-1 ${styles.nodePulse} rounded-full bg-foreground/40`,
							styles.variables
						)}
						key={i}
						style={
							{
								"--core-height": `${h}px`,
								"--core-delay": `${i * 0.12}s`,
							} satisfies CoreVariables as CoreVariables
						}
					/>
				))}
			</div>
		</div>
	);
}

const cards: {
	viz: ReactNode;
	title: string;
	description: string;
	span?: string;
}[] = [
	{
		viz: <SecurityViz />,
		title: "Security Firewall",
		description:
			"Every request is checked for prompt injection before it reaches a model.",
		span: "md:col-span-2",
	},
	{
		viz: <VaultViz />,
		title: "Encrypted at Rest",
		description:
			"Chats and secrets sealed on disk - the key lives in your OS keychain, never next to the data. Zero-access cloud, optional.",
	},
	{
		viz: <RouterViz />,
		title: "Dynamic Router",
		description: "Switch models on the fly - no code changes required.",
		span: "md:row-span-2",
	},
	{
		viz: <McpViz />,
		title: "MCP Registry",
		description:
			"Connect supported agents to configured MCP tools and services.",
	},
	{
		viz: <MemoryViz />,
		title: "Memory & RAG",
		description:
			"Agents keep long-term memory, so every session builds on the last.",
	},
	{
		viz: <CostViz />,
		title: "Cost Control",
		description:
			"Per-agent budgets and live token tracking, so the bill holds no surprises.",
		span: "md:col-span-2",
	},
	{
		viz: <WorkflowViz />,
		title: "Workflow Builder",
		description: "Chain agents visually. No custom orchestration code.",
	},
	{
		viz: <DlpViz />,
		title: "PII & DLP",
		description:
			"Detect and redact sensitive data before it leaves your machine — governed egress on every call.",
	},
	{
		viz: <AuditViz />,
		title: "Audit Trail",
		description:
			"Every model and tool call logged with full trace — review what ran, when, and under which policy.",
		span: "md:row-span-2",
	},
	{
		viz: <CacheViz />,
		title: "Semantic Cache",
		description:
			"Exact and semantic response caching cuts repeat costs and latency without changing your agents.",
	},
	{
		viz: <MediaViz />,
		title: "Voice & Image",
		description:
			"Image generation, audio, and voice recognition built in. Every modality first-class, all swappable, all local.",
		span: "md:col-span-2",
	},
];

export default function Core() {
	return (
		<div className="container mx-auto px-4 py-16">
			<div className="mx-auto mb-6 max-w-4xl">
				<SectionTitle
					className="max-w-lg"
					title="Industry grade AI agent suite of tools for normal people"
				/>
			</div>
			<div className="mx-auto grid max-w-4xl grid-flow-row-dense grid-cols-1 gap-3 md:auto-rows-[12rem] md:grid-cols-2 lg:grid-cols-3">
				{cards.map((card) => (
					<div
						className={cn(
							landingSurfaceCardFlexXlClass,
							"min-h-48 overflow-hidden md:h-full md:min-h-0",
							card.span
						)}
						key={card.title}
					>
						{card.viz}
						<div>
							<h3 className="mb-1 font-medium text-foreground text-lg">
								{card.title}
							</h3>
							<p className="text-muted-foreground text-sm">
								{card.description}
							</p>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
