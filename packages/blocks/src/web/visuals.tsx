"use client";

import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import {
	AppShell,
	CodePane,
	MinimalCard,
	Node,
	Terminal,
	Wire,
} from "./mockups.tsx";
import { Slot } from "./visuals-primitives.tsx";

export {
	AgentsAsServiceVisual,
	CloudVisual,
	CommandBarVisual,
	ComputeExchangeVisual,
	ConnectionsVisual,
	DesktopVisual,
	DevicesVisual,
	HealthcareDesktopVisual,
	IslandVisual,
	LegalDesktopVisual,
	RedTeamVisual,
} from "./visuals-desktop.tsx";
export {
	BotHeroVisual,
	BoxVisual,
	ConnectVisual,
	HireVisual,
	MailVisual,
	MessagingVisual,
	NotifyVisual,
	OsVisual,
	SitesVisual,
} from "./visuals-services.tsx";

/* ================================================================== */
/* Per-product hero visuals - composed from shared mockup primitives.  */
/* All monochrome + minimal to match the design system.                */
/* ================================================================== */

const RUN_DOT = new Map(
	Object.entries({
		running: "animate-pulse bg-foreground",
		done: "bg-foreground/40",
		queued: "bg-foreground/20",
	})
);

export function CoreVisual() {
	const runs = [
		{ name: "Refactor auth", state: "running" },
		{ name: "Summarize inbox", state: "done" },
		{ name: "Triage issues", state: "queued" },
	];
	return (
		<AppShell>
			<div className="space-y-2">
				{runs.map((r) => (
					<div
						className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5"
						key={r.name}
					>
						<span
							aria-hidden="true"
							className={cn("size-1.5 rounded-full", RUN_DOT.get(r.state))}
						/>
						<span className="text-foreground/80 text-sm">{r.name}</span>
					</div>
				))}
			</div>
		</AppShell>
	);
}

export function GatewayVisual() {
	return (
		<MinimalCard>
			<div className="flex items-center gap-2 py-2">
				<Node>Your agent</Node>
				<Wire className="flex-1" />
				<Node emphasis>Gateway</Node>
				<Wire className="flex-1" delays={[0.2, 0.6]} />
				<div className="space-y-1">
					<Node className="px-2 py-1">OpenAI</Node>
					<Node className="px-2 py-1">Claude</Node>
					<Node className="px-2 py-1">Local</Node>
				</div>
			</div>
		</MinimalCard>
	);
}

export function CliVisual() {
	return (
		<Terminal
			lines={[
				{ prompt: true, text: 'ryu-cli chat "summarize today\'s PRs"' },
				{ text: "3 merged, 1 waiting on review.", muted: true },
				{ prompt: true, text: "ryu-cli node ls" },
				{ text: "* localhost   studio   cloud", muted: true },
				{ prompt: true, text: "ryu-cli node use studio" },
				{ text: "Active node set to studio.", muted: true },
				{ prompt: true, text: "ryu-cli doctor" },
				{ text: "0 errors · 0 warnings · 0 info", muted: true },
			]}
		/>
	);
}

export function SdkVisual() {
	return (
		<CodePane
			code={`export default defineAgent({
  id: "agent", name: "Researcher",
  chat: "gemma-4",
  tools: [search],
});`}
			filename="agent.ts"
		/>
	);
}

/** Compact code visual sized to sit inside a 2x2 bento cell. */
export function CodePaneSplit() {
	return (
		<CodePane
			className="h-full"
			code={`defineAgent({ id, name, chat, tools });
defineWorkflow({ steps });
defineTool({ id, name, schema, run });
defineSkill({ md });`}
			filename="agent.ts"
		/>
	);
}

export function AgentsVisual() {
	return (
		<MinimalCard>
			<div className="grid gap-2">
				<Slot label="Model" value="Gemma 4" />
				<Slot label="Memory" value="Your Spaces" />
				<Slot label="Tools" value="Web search" />
			</div>
		</MinimalCard>
	);
}

/** A small workflow run: a trigger delegates to two sub-agents, then the results are summarized. */
export function WorkflowsVisual() {
	return (
		<div className="flex w-full flex-col items-stretch gap-2 px-1 py-6 sm:flex-row sm:items-center">
			<Node className="sm:flex-1">Trigger</Node>
			<span
				aria-hidden="true"
				className="mx-auto h-3 w-px shrink-0 bg-border sm:mx-0 sm:h-px sm:w-3"
			/>
			<Node className="sm:flex-1" emphasis>
				Delegate
			</Node>
			<span
				aria-hidden="true"
				className="mx-auto h-3 w-px shrink-0 bg-border sm:mx-0 sm:h-px sm:w-3"
			/>
			<div className="grid grid-cols-2 gap-2 sm:flex sm:flex-1 sm:flex-col">
				<Node>Research</Node>
				<Node>Draft</Node>
			</div>
			<span
				aria-hidden="true"
				className="mx-auto h-3 w-px shrink-0 bg-border sm:mx-0 sm:h-px sm:w-3"
			/>
			<Node className="sm:flex-1">Summarize</Node>
		</div>
	);
}

/** Connecting an existing agent to the Gateway: change the base URL, keep the provider. */
export function GatewayBaseUrlVisual() {
	return (
		<div className="flex h-full w-full flex-col justify-center px-1 py-2">
			<div className="space-y-1.5 whitespace-pre-wrap break-words px-2 font-mono text-[13px] leading-6 sm:text-sm sm:leading-relaxed">
				<p className="text-muted-foreground">const client = new OpenAI({"{"}</p>
				<p className="break-all pl-4 text-muted-foreground line-through">
					baseURL: "https://api.openai.com/v1",
				</p>
				<p className="-mx-2 break-all rounded-md bg-foreground/[0.06] px-2 py-0.5 pl-6 text-foreground">
					baseURL: "https://your-gateway/v1",
				</p>
				<p className="pl-4 text-muted-foreground">
					apiKey: process.env.API_KEY,
				</p>
				<p className="text-muted-foreground">{"});"}</p>
				<p className="pt-2 text-muted-foreground">
					await client.chat.completions.create(…);
				</p>
			</div>
		</div>
	);
}

/** Passport's vault: per-site sign-ins with their status, sealed credential state. */
export function PassportVaultVisual() {
	const connections = [
		{ site: "github.com", status: "Signed in" },
		{ site: "linear.app", status: "Signed in" },
		{ site: "notion.so", status: "Needs sign-in" },
	];
	return (
		<div className="w-full space-y-3 px-1 py-2">
			<div className="flex items-center justify-between">
				<span className="font-medium text-foreground text-sm">
					Work profile
				</span>
				<span className="type-compact text-muted-foreground">
					Credentials sealed
				</span>
			</div>
			<div className="space-y-2">
				{connections.map((c) => (
					<div
						className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
						key={c.site}
					>
						<span className="text-foreground/80 text-xs">{c.site}</span>
						<span
							className={cn(
								"type-compact",
								c.status === "Signed in"
									? "text-foreground"
									: "text-muted-foreground"
							)}
						>
							{c.status}
						</span>
					</div>
				))}
			</div>
			<div className="flex items-center gap-2">
				<Node>Agent</Node>
				<Wire className="flex-1" delays={[0.2, 0.6]} />
				<Node emphasis>Audited call</Node>
				<Wire className="flex-1" delays={[0.4, 0.8]} />
				<Node>Session</Node>
			</div>
		</div>
	);
}

/** Two tenants reaching different allowlisted tool sets through one Connect endpoint. */
export function ConnectTenantsVisual() {
	const tenants = [
		{ name: "Customer A", tools: ["Gmail", "Slack"] },
		{ name: "Customer B", tools: ["GitHub", "Linear"] },
	];
	return (
		<div className="w-full space-y-6 px-2 py-8 sm:px-6">
			<div className="flex justify-center">
				<Node className="w-48 py-2.5 text-sm" emphasis>
					Ryu Connect
				</Node>
			</div>
			<div className="grid grid-cols-2 gap-4 sm:gap-6">
				{tenants.map((t) => (
					<div className="space-y-3" key={t.name}>
						<p className="font-medium text-foreground text-sm">{t.name}</p>
						<div className="grid gap-2">
							{t.tools.map((tool) => (
								<Node className="py-2 text-sm" key={tool}>
									{tool}
								</Node>
							))}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

/** Public document skills from the open Agent Skills registry, installable in one click. */
export function SkillsVisual() {
	const skills = ["pdf", "docx", "xlsx", "pptx"];
	return (
		<MinimalCard>
			<div className="space-y-2">
				{skills.map((name, i) => (
					<div
						className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5"
						key={name}
					>
						<span className="text-foreground/80 text-sm">{name}</span>
						{i === 0 ? (
							<span className="text-muted-foreground text-sm">Installed</span>
						) : null}
					</div>
				))}
			</div>
		</MinimalCard>
	);
}

/** Ryu over MCP: each agent gets an allowlist of MCP tools, and risky ones wait for approval. */
export function McpVisual() {
	const tools = [
		{ name: "Screen capture", access: "Allowed" },
		{ name: "Desktop clicks", access: "Needs approval" },
		{ name: "Delete tickets", access: "Off" },
	];
	return (
		<MinimalCard>
			<div className="space-y-4">
				<span className="block font-medium text-foreground text-sm">
					Researcher
				</span>
				<div className="space-y-3">
					{tools.map((tool) => (
						<div
							className="flex items-center justify-between gap-3"
							key={tool.name}
						>
							<span className="min-w-0 truncate text-foreground/80 text-sm">
								{tool.name}
							</span>
							<span
								className={cn(
									"shrink-0 whitespace-nowrap text-sm",
									tool.access === "Allowed"
										? "text-foreground"
										: "text-muted-foreground"
								)}
							>
								{tool.access}
							</span>
						</div>
					))}
				</div>
			</div>
		</MinimalCard>
	);
}

/** Real catalog entries with their manifest display names, across several kinds. */
export function MarketplaceVisual() {
	const items = ["Browser", "Calendar", "PDF", "Spider"];
	return (
		<MinimalCard contentClassName="p-3">
			<div className="grid grid-cols-2 gap-2.5">
				{items.map((name) => (
					<div
						className="flex items-center gap-2.5 rounded-lg border border-border bg-background p-4"
						key={name}
					>
						<span
							aria-hidden="true"
							className="size-6 shrink-0 rounded-md bg-foreground/10"
						/>
						<span className="min-w-0 truncate text-foreground/80 text-sm">
							{name}
						</span>
					</div>
				))}
			</div>
		</MinimalCard>
	);
}

/** A plugin adds tools, model providers, and screens to Ryu. */
export function ExtensionsVisual() {
	const parts = ["Tool", "Model", "Screen"];
	return (
		<div className="flex w-full flex-col items-center px-1 py-6">
			<Node className="w-40 py-2.5 text-sm" emphasis>
				Plugin
			</Node>
			<span aria-hidden="true" className="h-5 w-px bg-foreground/30" />
			<div className="relative grid w-full max-w-sm grid-cols-3 gap-3">
				<span
					aria-hidden="true"
					className="absolute inset-x-[16.67%] top-0 h-px bg-foreground/30"
				/>
				{parts.map((name) => (
					<div className="flex flex-col items-center" key={name}>
						<span aria-hidden="true" className="h-5 w-px bg-foreground/30" />
						<Node className="w-full py-2.5 text-sm">{name}</Node>
					</div>
				))}
			</div>
		</div>
	);
}

export function PhoneFrame({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"mx-auto w-56 overflow-hidden rounded-4xl border border-border bg-background p-2",
				className
			)}
		>
			<div className="overflow-hidden rounded-3xl border border-border/60 bg-background">
				<div className="flex items-center justify-center py-2">
					<span className="h-1 w-12 rounded-full bg-foreground/15" />
				</div>
				<div className="px-3 pb-4">{children}</div>
			</div>
		</div>
	);
}

export function MobileVisual() {
	return (
		<div className="flex w-full justify-center py-4 md:py-6">
			<PhoneFrame className="w-64 sm:w-72">
				<div className="flex min-h-64 flex-col gap-3">
					<p className="font-medium text-foreground text-sm">Ryu</p>
					<div className="ml-auto max-w-[80%] rounded-2xl rounded-tr-sm bg-foreground px-3 py-2 text-background text-sm">
						Draft a reply
					</div>
					<div
						aria-hidden="true"
						className="w-4/5 space-y-2 rounded-2xl rounded-tl-sm border border-border/60 px-3 py-3"
					>
						<span className="block h-1.5 w-full rounded-full bg-foreground/15" />
						<span className="block h-1.5 w-5/6 rounded-full bg-foreground/10" />
						<span className="block h-1.5 w-2/3 rounded-full bg-foreground/10" />
					</div>
					<div
						aria-hidden="true"
						className="mt-auto flex items-center gap-2 rounded-full border border-border/60 px-3 py-2"
					>
						<span className="block h-1.5 w-1/3 rounded-full bg-foreground/10" />
						<span className="ml-auto size-5 rounded-full bg-foreground/80" />
					</div>
				</div>
			</PhoneFrame>
		</div>
	);
}

export function ChromeVisual() {
	return (
		<MinimalCard contentClassName="p-0">
			<div
				aria-hidden="true"
				className="flex min-h-56 flex-col gap-2 p-4 sm:aspect-[16/10] sm:flex-row sm:items-center sm:gap-6 sm:p-8"
			>
				<div className="flex-1 space-y-2.5">
					<span className="block h-2.5 w-1/2 rounded-full bg-foreground/25" />
					<span className="block h-1.5 w-11/12 rounded-full bg-foreground/10" />
					<span className="block h-1.5 w-4/5 rounded-full bg-foreground/30" />
					<span className="block h-1.5 w-full rounded-full bg-foreground/10" />
					<span className="block h-1.5 w-2/3 rounded-full bg-foreground/10" />
					<span className="block h-1.5 w-5/6 rounded-full bg-foreground/10" />
					<span className="block h-1.5 w-3/5 rounded-full bg-foreground/10" />
				</div>
				<div className="w-full shrink-0 space-y-2.5 sm:w-48">
					<div className="ml-auto w-fit rounded-lg bg-foreground px-2.5 py-1.5 text-background text-xs">
						Summarize this page
					</div>
					<div className="space-y-2 rounded-lg border border-border px-2.5 py-2.5">
						<span className="block h-1.5 w-5/6 rounded-full bg-foreground/20" />
						<span className="block h-1.5 w-full rounded-full bg-foreground/20" />
						<span className="block h-1.5 w-2/3 rounded-full bg-foreground/20" />
					</div>
				</div>
			</div>
		</MinimalCard>
	);
}
