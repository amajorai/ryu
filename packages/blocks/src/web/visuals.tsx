"use client";

import { cn } from "@ryu/ui/lib/utils";
import {
	Calendar,
	FileText,
	GitBranch,
	type LucideIcon,
	Mail,
	MessageSquare,
} from "lucide-react";
import type { ReactNode } from "react";
import {
	AppShell,
	CodePane,
	MinimalCard,
	Node,
	Terminal,
	WindowFrame,
	Wire,
} from "./mockups.tsx";

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

function Slot({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
			<span className="text-foreground/80 text-xs">{label}</span>
			<span className="shrink-0 text-foreground/80 text-xs md:text-sm">
				{value}
			</span>
		</div>
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

/** The desktop app: a short request and a reply drawn as placeholder lines. */
export function DesktopVisual({
	prompt = null,
}: {
	/** `null` (the default) draws the message as a text-free bar. */
	prompt?: string | null;
} = {}) {
	return (
		<WindowFrame className="w-full rounded-2xl" contentClassName="p-0">
			<div className="flex min-h-56 flex-col gap-3 p-4">
				{prompt === null ? (
					<div
						aria-hidden="true"
						className="ml-auto w-2/5 max-w-40 rounded-2xl rounded-tr-sm bg-foreground px-3 py-3"
					>
						<span className="block h-1.5 w-full rounded-full bg-background/40" />
					</div>
				) : (
					<div className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm bg-foreground px-3 py-2 text-background text-sm">
						{prompt}
					</div>
				)}
				<div
					aria-hidden="true"
					className="w-3/4 max-w-xs space-y-2 rounded-2xl rounded-tl-sm border border-border px-3 py-3"
				>
					<span className="block h-1.5 w-full rounded-full bg-foreground/15" />
					<span className="block h-1.5 w-5/6 rounded-full bg-foreground/10" />
					<span className="block h-1.5 w-2/3 rounded-full bg-foreground/10" />
				</div>
				<div
					aria-hidden="true"
					className="mt-auto flex items-center gap-2 rounded-full border border-border px-3 py-2"
				>
					<span className="block h-1.5 w-1/3 rounded-full bg-foreground/10" />
					<span className="ml-auto size-5 rounded-full bg-foreground/80" />
				</div>
			</div>
		</WindowFrame>
	);
}

const CLAUSE_BARS = ["w-full", "w-5/6", "w-11/12", "w-2/3", "w-4/5", "w-3/4"];

/** One document column of placeholder lines, with the compared clause highlighted. */
function ClauseColumn({ highlight }: { highlight: number }) {
	return (
		<div className="flex-1 space-y-2.5 rounded-lg border border-border bg-background p-4">
			{CLAUSE_BARS.map((width, i) => (
				<span
					className={cn(
						"block h-1.5 rounded-full",
						width,
						i === highlight ? "bg-foreground/70" : "bg-foreground/10"
					)}
					key={width}
				/>
			))}
		</div>
	);
}

/** Legal work: two agreements side by side with one matching clause marked in each. */
export function LegalDesktopVisual() {
	return (
		<WindowFrame contentClassName="p-0" title="Ryu">
			<div aria-hidden="true" className="flex min-h-56 items-center gap-3 p-4">
				<ClauseColumn highlight={2} />
				<ClauseColumn highlight={3} />
			</div>
		</WindowFrame>
	);
}

const INTAKE_FIELDS = [
	{ label: "w-1/4", field: "w-3/4", missing: false },
	{ label: "w-1/3", field: "w-1/2", missing: false },
	{ label: "w-1/5", field: "w-2/3", missing: true },
	{ label: "w-1/4", field: "w-3/5", missing: false },
];

/** Clinical admin: an intake form drawn as label and field bars, with one field flagged missing. */
export function HealthcareDesktopVisual() {
	return (
		<WindowFrame contentClassName="p-0" title="Ryu">
			<div
				aria-hidden="true"
				className="flex min-h-56 flex-col justify-center gap-3 p-4"
			>
				{INTAKE_FIELDS.map((row) => (
					<div
						className={cn(
							"flex items-center gap-3 rounded-lg border px-3 py-3",
							row.missing
								? "border-foreground/50 border-dashed"
								: "border-border"
						)}
						key={`${row.label}-${row.field}`}
					>
						<span
							className={cn(
								"block h-1.5 shrink-0 rounded-full bg-foreground/25",
								row.label
							)}
						/>
						{row.missing ? (
							<span className="ml-auto size-2 rounded-full bg-foreground" />
						) : (
							<span
								className={cn(
									"ml-auto block h-1.5 rounded-full bg-foreground/10",
									row.field
								)}
							/>
						)}
					</div>
				))}
			</div>
		</WindowFrame>
	);
}

export function IslandVisual() {
	return (
		<div className="w-full px-1 py-2">
			{/* a mock screen with the island overlay pinned to its top edge;
			    text-free: a filled and an outline pill stand in for its two actions */}
			<div className="flex w-full flex-col overflow-hidden rounded-2xl border border-border bg-card">
				<div aria-hidden="true" className="px-3 pt-3">
					<WindowDots />
				</div>
				<div aria-hidden="true" className="flex justify-center px-4 pt-2">
					<div className="flex items-center gap-2 rounded-full border border-border bg-background px-3 py-2">
						<span className="size-2 animate-pulse rounded-full bg-foreground/70" />
						<span className="h-6 w-20 rounded-full bg-foreground" />
						<span className="h-6 w-14 rounded-full border border-border" />
					</div>
				</div>
				<div aria-hidden="true" className="space-y-2.5 px-6 pt-6 pb-6">
					<span className="block h-1.5 w-2/5 rounded-full bg-foreground/30" />
					<span className="block h-1.5 w-3/4 rounded-full bg-foreground/10" />
					<span className="block h-1.5 w-1/2 rounded-full bg-foreground/10" />
					<span className="block h-1.5 w-2/3 rounded-full bg-foreground/10" />
				</div>
			</div>
		</div>
	);
}

const DEFAULT_CONNECTIONS = [
	{ name: "Mail", Icon: Mail, on: true },
	{ name: "Chat", Icon: MessageSquare, on: true },
	{ name: "Docs", Icon: FileText, on: true },
	{ name: "Code", Icon: GitBranch, on: false },
	{ name: "Calendar", Icon: Calendar, on: false },
] as const;

/**
 * Connected apps as one outlined card: a monochrome app icon, a placeholder
 * bar, and an on/off switch per row. Text-free; whitespace separates rows.
 */
export function ConnectionsVisual({
	apps = DEFAULT_CONNECTIONS,
}: {
	apps?: ReadonlyArray<{ name: string; Icon: LucideIcon; on: boolean }>;
}) {
	return (
		<div
			aria-hidden="true"
			className="w-full space-y-4 rounded-2xl border border-border bg-card p-5"
		>
			{apps.map(({ name, Icon, on }) => (
				<div className="flex items-center gap-3" key={name}>
					<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground/60">
						<Icon className="size-4" />
					</span>
					<span
						className={cn(
							"block h-1.5 w-1/3 rounded-full",
							on ? "bg-foreground/20" : "bg-foreground/10"
						)}
					/>
					<span
						className={cn(
							"ml-auto flex h-4 w-7 items-center rounded-full p-0.5",
							on
								? "justify-end bg-foreground"
								: "justify-start bg-foreground/20"
						)}
					>
						<span className="size-3 rounded-full bg-background" />
					</span>
				</div>
			))}
		</div>
	);
}

/** Ryu Cloud hosts the servers; each client connects to it. */
export function CloudVisual() {
	const clients = ["a", "b", "c"];
	return (
		<div className="flex w-full flex-col items-center px-1 py-6">
			<Node className="w-44 py-2.5 text-sm" emphasis>
				Ryu Cloud
			</Node>
			<span aria-hidden="true" className="h-5 w-px bg-foreground/30" />
			<div className="relative grid w-full max-w-sm grid-cols-3 gap-3">
				<span
					aria-hidden="true"
					className="absolute inset-x-[16.67%] top-0 h-px bg-foreground/30"
				/>
				{clients.map((id) => (
					<div
						aria-hidden="true"
						className="flex flex-col items-center"
						key={id}
					>
						<span className="h-5 w-px bg-foreground/30" />
						<span className="flex w-full items-center gap-2 rounded-md border border-border bg-background px-2.5 py-3">
							<span className="size-3 shrink-0 rounded-full bg-foreground/25" />
							<span className="flex-1 space-y-1.5">
								<span className="block h-1.5 w-full rounded-full bg-foreground/15" />
								<span className="block h-1.5 w-2/3 rounded-full bg-foreground/10" />
							</span>
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

/** One row of a segmented choice, with the first matching option selected. */
function Segmented({
	label,
	options,
	selected,
}: {
	label: string;
	options: readonly string[];
	selected: string;
}) {
	return (
		<div className="space-y-1.5">
			<p className="text-muted-foreground text-xs">{label}</p>
			<div className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg border border-border p-1">
				{options.map((option) => (
					<span
						className={cn(
							"whitespace-nowrap rounded-md px-2 py-1.5 text-center text-xs md:text-sm",
							option === selected
								? "bg-foreground/[0.08] font-medium text-foreground"
								: "text-foreground/80"
						)}
						key={option}
					>
						{option}
					</span>
				))}
			</div>
		</div>
	);
}

/**
 * The exchange setup shared by the Compute and Share pages, mirroring the
 * desktop preview: hardware and lease choices for renters, an offer and an
 * availability choice for providers. Neither can be submitted yet.
 */
export function ComputeExchangeVisual({
	mode = "compute",
}: {
	mode?: "compute" | "share";
}) {
	const compute = mode === "compute";
	return (
		<MinimalCard className="mx-auto w-full max-w-md">
			<div className="space-y-5">
				{compute ? (
					<>
						<Segmented
							label="Hardware"
							options={["CPU", "GPU"]}
							selected="GPU"
						/>
						<Segmented
							label="Lease"
							options={["15 min", "1 hour", "4 hours"]}
							selected="1 hour"
						/>
					</>
				) : (
					<>
						<Segmented
							label="Offer"
							options={["Spare compute", "Hosted agent"]}
							selected="Spare compute"
						/>
						<Segmented
							label="Availability"
							options={["When idle", "On a schedule"]}
							selected="When idle"
						/>
					</>
				)}
				{/* Disabled in the desktop preview (ComputeShareSurface.tsx), so it
				    is drawn as an unavailable action, not a button. */}
				<div
					aria-disabled="true"
					className="rounded-lg border border-border border-dashed px-3 py-2 text-center text-muted-foreground text-xs md:text-sm"
				>
					{compute ? "Find capacity" : "Publish listing"}
				</div>
			</div>
		</MinimalCard>
	);
}

/** The Desktop "Security sweep" result: the ten built-in red-team strategies, one case each. */
export function RedTeamVisual() {
	const strategies = [
		{ name: "Prompt injection", protected: true },
		{ name: "Jailbreak resistance", protected: false },
		{ name: "Personal data leak", protected: true },
		{ name: "Tool misuse", protected: true },
		{ name: "Toxic output", protected: true },
		{ name: "System-prompt leak", protected: true },
		{ name: "Indirect prompt injection", protected: true },
		{ name: "SQL injection", protected: true },
		{ name: "Shell injection", protected: true },
		{ name: "Bias and fairness", protected: true },
	];
	/* Text-free: nine quiet outline tiles held, and one stronger dashed outline
	   for the probe that got through, so the odd one out reads as the failure. */
	return (
		<div className="w-full rounded-2xl border border-border bg-card">
			<div aria-hidden="true" className="px-3 pt-3">
				<WindowDots />
			</div>
			<div aria-hidden="true" className="grid grid-cols-5 gap-3 p-5 pt-3">
				{strategies.map((strategy) => (
					<span
						className={cn(
							"block h-12 rounded-lg",
							strategy.protected
								? "border border-border bg-muted/40"
								: "border-2 border-foreground/50 border-dashed"
						)}
						data-protected={strategy.protected}
						key={strategy.name}
					/>
				))}
			</div>
		</div>
	);
}

export function DevicesVisual() {
	return (
		<div className="flex w-full flex-col items-center gap-6 px-2 py-8">
			<div className="flex items-end justify-center gap-4 sm:gap-8">
				<figure className="flex flex-col items-center gap-2">
					<div className="flex flex-col items-center">
						<span className="h-5 w-10 rounded-t-md border border-foreground/40 border-b-0" />
						<span className="relative flex size-20 items-center justify-center rounded-full border-2 border-foreground/50">
							<span className="size-1.5 rounded-full bg-foreground motion-safe:animate-pulse" />
						</span>
						<span className="h-5 w-10 rounded-b-md border border-foreground/40 border-t-0" />
					</div>
					<figcaption className="text-muted-foreground text-sm">
						Watch
					</figcaption>
				</figure>
				<figure className="flex flex-col items-center gap-2">
					<div className="flex flex-col items-center">
						<span className="h-16 w-20 rounded-b-full border border-foreground/40 border-t-0" />
						<span className="-mt-1 size-9 rounded-full border-2 border-foreground/50" />
					</div>
					<figcaption className="text-muted-foreground text-sm">
						Necklace
					</figcaption>
				</figure>
				<figure className="flex flex-col items-center gap-2">
					<div className="flex flex-col items-center">
						<span className="flex h-20 w-32 flex-col justify-center gap-2 rounded-md border-2 border-foreground/50 px-4">
							<span className="h-1 w-3/4 rounded-full bg-foreground/25" />
							<span className="h-1 w-1/2 rounded-full bg-foreground/15" />
						</span>
						<span className="h-3 w-12 rounded-b-sm border border-foreground/40 border-t-0" />
					</div>
					<figcaption className="text-muted-foreground text-sm">
						Desk display
					</figcaption>
				</figure>
			</div>
		</div>
	);
}

export function CommandBarVisual() {
	const results = ["Chat", "Spaces", "Skills", "Mission Control"];
	return (
		<WindowFrame contentClassName="p-6" title="OS">
			<div className="mx-auto max-w-sm overflow-hidden rounded-xl border border-border bg-card">
				<div className="flex items-center gap-2 px-3 pt-3 pb-2">
					<span className="text-muted-foreground text-sm">⌘</span>
					<span className="text-muted-foreground text-sm">Search apps…</span>
					<span
						aria-hidden="true"
						className="ml-auto inline-block h-3.5 w-px animate-pulse bg-foreground/50"
					/>
				</div>
				<div className="p-1.5">
					{results.map((name, i) => (
						<div
							className={cn(
								"rounded-lg px-2.5 py-2 text-foreground/80 text-sm",
								i === 0 ? "bg-foreground/10 text-foreground" : ""
							)}
							key={name}
						>
							{name}
						</div>
					))}
				</div>
			</div>
		</WindowFrame>
	);
}

export function AgentsAsServiceVisual() {
	const steps = ["Your task", "We scope it", "Set up"];
	return (
		<MinimalCard>
			<div className="space-y-4">
				<ol className="flex items-center gap-2 text-muted-foreground text-xs">
					{steps.map((step, i) => (
						<li
							className={cn(
								"flex items-center gap-2",
								i === 1 ? "font-medium text-foreground" : ""
							)}
							key={step}
						>
							{i > 0 ? <span aria-hidden="true">→</span> : null}
							{step}
						</li>
					))}
				</ol>
				<div className="space-y-2">
					<p className="font-medium text-foreground text-sm">
						Weekly sales summary
					</p>
					<Slot label="Task" value="Summarize the pipeline" />
					<Slot label="Tools" value="CRM · Email" />
					<Slot label="Runs on" value="Ryu Cloud or your machines" />
				</div>
			</div>
		</MinimalCard>
	);
}

/** A mock window's title-bar strip: three quiet dots, no label. */
function WindowDots() {
	return (
		<span className="flex h-5 shrink-0 items-center gap-1 px-2">
			<span className="size-1.5 rounded-full bg-foreground/20" />
			<span className="size-1.5 rounded-full bg-foreground/20" />
			<span className="size-1.5 rounded-full bg-foreground/20" />
		</span>
	);
}

/** The public OS story: app windows are opened from one workspace dock. */
export function OsVisual() {
	const apps = ["Launcher", "Chat", "Spaces", "Skills", "Review"];
	return (
		<WindowFrame title="OS">
			<div aria-hidden="true" className="relative h-36 sm:h-44">
				<span className="absolute top-2 left-0 flex h-24 w-3/5 flex-col overflow-hidden rounded-lg border border-border bg-muted/50 sm:h-28">
					<WindowDots />
				</span>
				<span className="absolute top-8 right-0 flex h-24 w-1/2 flex-col overflow-hidden rounded-lg border border-foreground/30 bg-background sm:top-10 sm:h-28">
					<WindowDots />
					<span className="flex flex-1 flex-col justify-center gap-1.5 px-3 pb-2">
						<span className="ml-auto block h-3 w-2/5 rounded-full rounded-tr-sm bg-foreground/80" />
						<span className="block h-3 w-3/5 rounded-full rounded-tl-sm border border-border bg-foreground/5" />
						<span className="ml-auto block h-3 w-1/3 rounded-full rounded-tr-sm bg-foreground/80" />
					</span>
				</span>
			</div>
			<ul
				aria-label="Dock"
				className="mx-auto mt-4 flex w-fit max-w-full items-center justify-center gap-1.5 rounded-2xl border border-border px-2 py-1.5"
			>
				{apps.map((app) => (
					<li
						className={cn(
							"rounded-lg px-2.5 py-1 text-xs",
							app === "Chat"
								? "bg-foreground text-background"
								: "text-muted-foreground",
							app === "Review" ? "hidden sm:block" : ""
						)}
						key={app}
					>
						{app}
					</li>
				))}
			</ul>
		</WindowFrame>
	);
}

/** Ryu Connect: one API between your app and hosted MCP servers, Skills, and tools. */
export function ConnectVisual() {
	const kinds = ["MCP servers", "Skills", "Tools"];
	return (
		<div className="flex w-full flex-col items-center px-1 py-6">
			<Node className="w-44 py-2.5 text-sm">Your app</Node>
			<span aria-hidden="true" className="h-6 w-px bg-foreground/30" />
			<Node className="w-44 py-2.5 text-sm" emphasis>
				Connect
			</Node>
			<span aria-hidden="true" className="h-5 w-px bg-foreground/30" />
			<div className="relative grid w-full max-w-sm grid-cols-3 gap-3">
				<span
					aria-hidden="true"
					className="absolute inset-x-[16.67%] top-0 h-px bg-foreground/30"
				/>
				{kinds.map((kind) => (
					<div className="flex flex-col items-center" key={kind}>
						<span aria-hidden="true" className="h-5 w-px bg-foreground/30" />
						<Node className="w-full whitespace-nowrap py-2.5 text-sm">
							{kind}
						</Node>
					</div>
				))}
			</div>
		</div>
	);
}

/** The isolated, persistent workspace behind a Ryu Box run. */
export function BoxVisual() {
	return (
		<div className="flex w-full items-center justify-center gap-0 px-2 py-8 sm:px-6">
			<BoxWindow />
			<span
				aria-hidden="true"
				className="h-px w-6 shrink-0 bg-foreground/30 sm:w-10"
			/>
			<BoxWindow forked />
		</div>
	);
}

/** One Box workspace drawn as a small window of file lines; the fork carries its only label. */
function BoxWindow({ forked = false }: { forked?: boolean }) {
	return (
		<div
			className={cn(
				"relative flex w-full max-w-44 flex-col overflow-hidden rounded-lg border bg-background",
				forked ? "border-foreground/40" : "border-border"
			)}
		>
			<WindowDots />
			<span aria-hidden="true" className="space-y-2 px-3 pt-2 pb-4">
				<span className="block h-1.5 w-3/4 rounded-full bg-foreground/15" />
				<span className="block h-1.5 w-1/2 rounded-full bg-foreground/10" />
				<span className="block h-1.5 w-2/3 rounded-full bg-foreground/10" />
			</span>
			{forked ? (
				<span className="absolute top-1 right-2 rounded-md border border-border px-1.5 py-0.5 text-muted-foreground text-xs">
					Fork
				</span>
			) : null}
		</div>
	);
}

/** The standalone event inbox behind Ryu Notify: delivery, live updates, and replies. */
export function NotifyVisual() {
	const events = [
		{ label: "Deploy complete", dot: "bg-foreground/40" },
		{ label: "Build 62%", dot: "animate-pulse bg-foreground" },
		{ label: "Restore backup?", dot: "bg-foreground/20" },
	];
	return (
		<MinimalCard>
			<div className="space-y-2">
				{events.map((event) => (
					<div
						className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-3"
						key={event.label}
					>
						<span
							aria-hidden="true"
							className={cn("size-1.5 shrink-0 rounded-full", event.dot)}
						/>
						<span className="truncate text-foreground/80 text-sm">
							{event.label}
						</span>
					</div>
				))}
			</div>
		</MinimalCard>
	);
}

/** Standalone Ryu Sites: a saved version passes its deploy scan and goes live. */
export function SitesVisual() {
	const rows = ["Saved", "Secret scan", "Live"];
	return (
		<MinimalCard>
			<div className="flex min-h-48 flex-col justify-center space-y-2">
				{rows.map((label, i) => (
					<div
						className={cn(
							"flex items-center gap-2.5 rounded-lg border px-3 py-3",
							i === rows.length - 1 ? "border-foreground/40" : "border-border"
						)}
						key={label}
					>
						<span
							aria-hidden="true"
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								i === rows.length - 1 ? "bg-foreground" : "bg-foreground/40"
							)}
						/>
						<span className="text-foreground/80 text-sm">{label}</span>
					</div>
				))}
			</div>
		</MinimalCard>
	);
}

/** The API-first Agent Inboxes product, distinct from the event inbox. */
export function MailVisual() {
	const flows = [
		{ label: "Received", arrow: "↓" },
		{ label: "Sent", arrow: "↑" },
	];
	return (
		<MinimalCard>
			<div className="space-y-4">
				<div className="flex items-center gap-2.5">
					<Node className="py-2 text-sm" emphasis>
						Agent
					</Node>
					<span className="rounded-full border border-border px-2.5 py-1 text-muted-foreground text-sm">
						research@…
					</span>
				</div>
				<div className="space-y-2">
					{flows.map((flow) => (
						<div
							className="flex items-center gap-3 rounded-lg border border-border px-3 py-3"
							key={flow.label}
						>
							<span
								aria-hidden="true"
								className="text-muted-foreground text-sm"
							>
								{flow.arrow}
							</span>
							<span className="text-foreground/80 text-sm">{flow.label}</span>
							<span
								aria-hidden="true"
								className="ml-auto block h-1.5 w-1/3 rounded-full bg-foreground/10"
							/>
						</div>
					))}
				</div>
			</div>
		</MinimalCard>
	);
}

/**
 * Ryu Messaging: one conversation across channels, with each send's hold and
 * settled charge shown as states, not prices (rates come from AWS).
 */
export function MessagingVisual() {
	const messages = [
		{
			channel: "SMS",
			to: "+65 •••• 4821",
			state: "delivered",
			tone: "success",
		},
		{ channel: "WhatsApp", to: "+44 •••• 1907", state: "held", tone: "info" },
		{ channel: "Voice", to: "+1 •••• 5530", state: "settled", tone: "success" },
	];
	return (
		<WindowFrame title="Ryu Messaging · outbound">
			<div className="space-y-3">
				<div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2">
					<span className="type-caption font-mono text-foreground/75">
						/api/messaging
					</span>
					<span className="type-compact inline-flex items-center gap-1.5 text-foreground/55">
						<span className="size-1.5 rounded-full bg-success" />
						AWS price, no markup
					</span>
				</div>
				<div className="space-y-2">
					{messages.map((message) => (
						<div
							className="flex items-center gap-2 rounded-lg border border-border bg-foreground/[0.03] px-3 py-2"
							key={message.channel}
						>
							<span
								className={cn(
									"size-1.5 rounded-full",
									message.tone === "success" ? "bg-success" : "bg-info"
								)}
							/>
							<span className="min-w-0 flex-1">
								<span className="type-caption block truncate text-foreground/75">
									{message.channel}
								</span>
								<span className="type-micro block truncate font-mono text-muted-foreground">
									{message.to}
								</span>
							</span>
							<span className="type-micro font-mono text-muted-foreground/70">
								{message.state}
							</span>
						</div>
					))}
				</div>
			</div>
		</WindowFrame>
	);
}

/**
 * Ryu Hire is early access: an illustrative specialist list with no prices,
 * because no Hire run, estimate, or charge exists yet.
 */
export function HireVisual() {
	const hires = ["Policy analyst", "Release reviewer", "Inbox triage"];
	return (
		<MinimalCard>
			<div className="space-y-2">
				{hires.map((name, index) => (
					<div
						className={cn(
							"rounded-lg border px-3 py-3 text-foreground/80 text-sm",
							index === 0 ? "border-foreground/30" : "border-border"
						)}
						key={name}
					>
						{name}
					</div>
				))}
			</div>
		</MinimalCard>
	);
}

const BOT_THREADS = [
	{ id: "a", tone: "bg-foreground/60", bar: "w-3/4" },
	{ id: "b", tone: "bg-foreground/35", bar: "w-2/3" },
	{ id: "c", tone: "bg-foreground/25", bar: "w-4/5" },
	{ id: "d", tone: "bg-foreground/15", bar: "w-1/2" },
	{ id: "e", tone: "bg-foreground/15", bar: "w-3/5" },
];

/**
 * The Bot workspace, text-free: a thread list on the left and the open thread
 * on the right, with a request, the returned result, and a review action.
 */
export function BotHeroVisual() {
	return (
		<WindowFrame className="w-full rounded-2xl" contentClassName="p-0">
			<div aria-hidden="true" className="grid min-h-64 grid-cols-[38%_1fr]">
				<div className="space-y-3 bg-muted/30 p-4">
					{BOT_THREADS.map((thread, index) => (
						<div
							className={cn(
								"flex items-center gap-2.5 rounded-lg px-2 py-2",
								index === 0 && "bg-background"
							)}
							key={thread.id}
						>
							<span
								className={cn("size-6 shrink-0 rounded-full", thread.tone)}
							/>
							<span
								className={cn(
									"block h-1.5 rounded-full bg-foreground/15",
									thread.bar
								)}
							/>
						</div>
					))}
				</div>
				<div className="flex flex-col gap-3 p-4">
					<div className="ml-auto w-2/5 rounded-2xl rounded-tr-sm bg-foreground px-3 py-3">
						<span className="block h-1.5 w-full rounded-full bg-background/40" />
					</div>
					<div className="w-4/5 space-y-2 rounded-2xl rounded-tl-sm bg-muted px-3 py-3">
						<span className="block h-1.5 w-full rounded-full bg-foreground/15" />
						<span className="block h-1.5 w-5/6 rounded-full bg-foreground/10" />
						<span className="block h-1.5 w-2/3 rounded-full bg-foreground/10" />
					</div>
					<span className="h-6 w-16 rounded-full border border-border" />
					<div className="mt-auto flex items-center gap-2 rounded-full border border-border px-3 py-2">
						<span className="block h-1.5 w-1/3 rounded-full bg-foreground/10" />
						<span className="ml-auto size-5 rounded-full bg-foreground/80" />
					</div>
				</div>
			</div>
		</WindowFrame>
	);
}
