"use client";

import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import {
	AppShell,
	CodePane,
	MinimalCard,
	Node,
	Pill,
	Terminal,
	WindowFrame,
	Wire,
} from "./mockups.tsx";

/* ================================================================== */
/* Per-product hero visuals - composed from shared mockup primitives.  */
/* All monochrome + minimal to match the design system.                */
/* ================================================================== */

const RUN_DOT: Record<string, string> = {
	running: "animate-pulse bg-foreground",
	done: "bg-foreground/40",
	queued: "bg-foreground/20",
};

export function CoreVisual() {
	const runs = [
		{ name: "refactor-auth", state: "running" },
		{ name: "summarize-inbox", state: "done" },
		{ name: "draft-release-notes", state: "done" },
		{ name: "triage-issues", state: "queued" },
	];
	return (
		<AppShell
			active="Runs"
			nav={["Chat", "Agents", "Runs", "Models", "Spaces"]}
		>
			<div className="space-y-3">
				<div className="flex items-center justify-between">
					<span className="font-medium text-foreground text-sm">Runs</span>
					<span className="rounded-md border border-border bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground">
						local · :7980
					</span>
				</div>
				<div className="space-y-2">
					{runs.map((r) => (
						<div
							className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2"
							key={r.name}
						>
							<span className="font-mono text-foreground/80 text-xs">
								{r.name}
							</span>
							<span
								className={cn(
									"inline-flex items-center gap-1.5 text-[11px]",
									r.state === "running"
										? "text-foreground"
										: "text-muted-foreground"
								)}
							>
								<span
									className={cn("size-1.5 rounded-full", RUN_DOT[r.state])}
								/>
								{r.state}
							</span>
						</div>
					))}
				</div>
			</div>
		</AppShell>
	);
}

export function GatewayVisual() {
	return (
		<MinimalCard>
			<div className="space-y-4">
				<div className="flex items-center gap-2">
					<Node>Your Agent</Node>
					<Wire className="flex-1" />
					<Node emphasis>GATEWAY</Node>
					<Wire className="flex-1" delays={[0.2, 0.6]} />
					<div className="space-y-1">
						<Node className="px-2 py-1">OpenAI</Node>
						<Node className="px-2 py-1">Claude</Node>
						<Node className="px-2 py-1">Local</Node>
					</div>
				</div>
				<div className="grid grid-cols-4 gap-2">
					{["Firewall", "Routing", "Budgets", "Audit"].map((m) => (
						<div
							className="rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-center text-[11px] text-foreground/70"
							key={m}
						>
							{m}
						</div>
					))}
				</div>
				<div className="flex items-center gap-2 rounded-md border border-border bg-foreground/[0.03] px-3 py-2">
					<span className="size-2 rounded-full bg-foreground/30" />
					<span className="font-mono text-[11px] text-muted-foreground">
						blocked prompt-injection · routed to claude-opus · $0.012
					</span>
				</div>
			</div>
		</MinimalCard>
	);
}

export function CliVisual() {
	return (
		<Terminal
			lines={[
				{ prompt: true, text: "ryu chat" },
				{ text: "◆ Pi · gemma-4 (local) · gateway on", muted: true },
				{ prompt: true, text: "ryu run refactor-auth --worktree" },
				{ text: "→ spawned acp session · 3 tools allowed", muted: true },
				{ text: "→ diff ready · 12 files · ryu apply", muted: true },
				{ prompt: true, text: "ryu nodes" },
				{ text: "● localhost  ● studio.lan  ○ cloud", muted: true },
			]}
		/>
	);
}

export function SdkVisual() {
	return (
		<CodePane
			code={`import { defineAgent, defineTool } from "@ryuhq/sdk";

export const search = defineTool({
  name: "search",
  run: async ({ q }) => web.find(q),
});

export default defineAgent({
  model: "gemma-4",      // swappable
  tools: [search],       // any MCP / Runnable
  gateway: true,         // every call governed
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
			code={`defineAgent({ model, tools });
defineWorkflow({ steps });
defineTool({ name, run });
defineSkill({ md });`}
			filename="runnables.ts"
		/>
	);
}

function Slot({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2">
			<span className="text-[11px] text-muted-foreground">{label}</span>
			<span className="font-mono text-[11px] text-foreground/80">{value}</span>
		</div>
	);
}

export function AgentsVisual() {
	return (
		<MinimalCard>
			<div className="space-y-3">
				<div className="flex items-center gap-3">
					<div className="flex size-10 items-center justify-center rounded-lg border border-border bg-foreground/5 font-semibold text-foreground text-sm">
						Pi
					</div>
					<div>
						<p className="font-medium text-foreground text-sm">Pi</p>
						<p className="text-[11px] text-muted-foreground">
							swappable slots · zero lock-in
						</p>
					</div>
				</div>
				<div className="grid gap-2">
					<Slot label="Chat" value="gemma-4" />
					<Slot label="Voice" value="kokoro-tts" />
					<Slot label="Memory" value="spaces + rag" />
					<Slot label="Tools" value="ghost · spider" />
					<Slot label="Policy" value="gateway:strict" />
				</div>
			</div>
		</MinimalCard>
	);
}

export function WorkflowsVisual() {
	const nodes = ["Trigger", "Classify", "Agent A", "Agent B", "Summarize"];
	return (
		<MinimalCard>
			<div className="relative flex min-h-44 items-center">
				<svg
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 h-full w-full text-foreground"
					fill="none"
				>
					{[0, 1, 2, 3].map((i) => (
						<line
							className="animate-edge-trace"
							key={`edge-${i}`}
							stroke="currentColor"
							strokeDasharray="80"
							strokeOpacity="0.3"
							strokeWidth="1"
							style={{ animationDelay: `${i * 0.5}s` }}
							x1={`${(i / 4) * 100 + 8}%`}
							x2={`${((i + 1) / 4) * 100}%`}
							y1="50%"
							y2="50%"
						/>
					))}
				</svg>
				<div className="flex w-full items-center justify-between gap-2">
					{nodes.map((n, i) => (
						<div
							className="shrink-0 animate-node-pulse rounded-md border border-border bg-muted/50 px-2 py-1.5 text-center text-[11px] text-foreground/80"
							key={n}
							style={{ animationDelay: `${i * 0.5}s` }}
						>
							{n}
						</div>
					))}
				</div>
			</div>
		</MinimalCard>
	);
}

export function SkillsVisual() {
	const skills = [
		{ name: "pdf-extract", by: "ryu" },
		{ name: "lighthouse", by: "vercel" },
		{ name: "security-review", by: "amajor" },
		{ name: "e2e-tests", by: "ryu" },
	];
	return (
		<MinimalCard>
			<div className="space-y-2">
				{skills.map((s, i) => (
					<div
						className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2"
						key={s.name}
					>
						<div className="flex items-center gap-2.5">
							<div className="flex size-7 items-center justify-center rounded-md border border-border bg-muted/50 font-mono text-[10px] text-foreground/60">
								MD
							</div>
							<div>
								<p className="font-mono text-foreground/80 text-xs">{s.name}</p>
								<p className="text-[10px] text-muted-foreground">@{s.by}</p>
							</div>
						</div>
						<span
							className={cn(
								"rounded-md px-2 py-1 text-[10px]",
								i === 0
									? "bg-foreground font-medium text-background"
									: "border border-border bg-muted/50 text-foreground/70"
							)}
						>
							{i === 0 ? "Installed" : "Install"}
						</span>
					</div>
				))}
			</div>
		</MinimalCard>
	);
}

export function McpVisual() {
	const tools = [
		"GitHub",
		"Slack",
		"Postgres",
		"Browser",
		"Email",
		"Cal",
		"Notion",
		"Linear",
		"Stripe",
	];
	return (
		<MinimalCard>
			<div className="space-y-4">
				<div className="flex flex-wrap gap-2">
					{tools.map((t, i) => (
						<span
							className="inline-flex animate-tool-float items-center rounded-full border border-border bg-muted/50 px-2.5 py-1 text-foreground/70 text-xs"
							key={t}
							style={{ animationDelay: `${i * 0.25}s` }}
						>
							{t}
						</span>
					))}
				</div>
				<div className="flex items-center gap-2">
					<Node>Agent</Node>
					<Wire className="flex-1" />
					<Node emphasis>MCP bridge</Node>
					<Wire className="flex-1" delays={[0.3, 0.7]} />
					<Node>Tools</Node>
				</div>
			</div>
		</MinimalCard>
	);
}

export function MarketplaceVisual() {
	const apps = [
		"agentbrowser",
		"spider",
		"claw-patrol",
		"promptfoo",
		"ghost",
		"shadow",
	];
	return (
		<MinimalCard contentClassName="p-3">
			<div className="grid grid-cols-2 gap-2.5">
				{apps.map((a) => (
					<div
						className="rounded-lg border border-border bg-muted/30 p-3"
						key={a}
					>
						<div className="mb-2 size-7 rounded-md border border-border bg-muted/50" />
						<p className="font-mono text-foreground/80 text-xs">{a}</p>
						<p className="text-[10px] text-muted-foreground">app · ryu.json</p>
					</div>
				))}
			</div>
		</MinimalCard>
	);
}

export function ExtensionsVisual() {
	return (
		<CodePane
			code={`{
  "name": "spider",
  "kind": "tool",
  "runnables": ["scrape", "crawl"],
  "permissions": ["net:read"],
  "gateway": { "policy": "strict" }
}`}
			filename="ryu.json"
		/>
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
				"mx-auto w-56 overflow-hidden rounded-[2rem] border border-border bg-muted/30 p-2 shadow-sm backdrop-blur-sm",
				className
			)}
		>
			<div className="overflow-hidden rounded-[1.5rem] border border-border/60 bg-muted/20">
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
		<PhoneFrame>
			<div className="space-y-3">
				<p className="font-medium text-foreground text-xs">Ryu</p>
				<div className="ml-auto max-w-[80%] rounded-2xl rounded-tr-sm bg-foreground px-3 py-2 text-[11px] text-background">
					Summarize today's standup
				</div>
				<div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-border/60 bg-background/60 px-3 py-2 text-[11px] text-foreground/80">
					On-device with Cactus. 3 blockers, 2 shipped. Want the thread?
				</div>
				<div className="flex items-center gap-2 rounded-full border border-border/60 bg-background/60 px-3 py-2">
					<span className="text-[11px] text-muted-foreground">Message…</span>
					<span className="ml-auto size-5 rounded-full bg-foreground/80" />
				</div>
			</div>
		</PhoneFrame>
	);
}

export function ChromeVisual() {
	return (
		<MinimalCard contentClassName="p-0">
			<div className="flex min-h-48">
				<div className="flex-1 space-y-2 p-4">
					<div className="h-2.5 w-2/3 rounded bg-foreground/10" />
					<div className="h-2 w-full rounded bg-foreground/[0.06]" />
					<div className="h-2 w-5/6 rounded bg-foreground/[0.06]" />
					<div className="h-2 w-3/4 rounded bg-foreground/[0.06]" />
				</div>
				<div className="w-44 shrink-0 space-y-2.5 bg-muted/40 p-3">
					<div className="flex items-center gap-2">
						<span className="size-2 animate-pulse rounded-full bg-foreground/60" />
						<span className="font-medium text-[11px] text-foreground">
							Ryu sidebar
						</span>
					</div>
					<div className="rounded-lg border border-border bg-card px-2.5 py-2 text-[10px] text-foreground/70">
						Summarize this page
					</div>
					<div className="rounded-lg border border-border bg-card px-2.5 py-2 text-[10px] text-muted-foreground">
						Reads the tab · DLP on egress
					</div>
					<div className="flex flex-wrap gap-1.5">
						{["Summarize", "Extract", "Ask"].map((c) => (
							<Pill className="text-[10px]" key={c}>
								{c}
							</Pill>
						))}
					</div>
				</div>
			</div>
		</MinimalCard>
	);
}

export function DesktopVisual() {
	return (
		<AppShell
			active="Chat"
			nav={["Chat", "Agents", "Runs", "Spaces", "Gateway"]}
		>
			<div className="flex h-full flex-col gap-3">
				<div className="ml-auto max-w-[80%] rounded-2xl rounded-tr-sm bg-foreground px-3 py-2 text-[11px] text-background">
					Refactor the auth module and open a PR
				</div>
				<div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-border bg-card px-3 py-2 text-[11px] text-foreground/80">
					Working in a worktree. Edited 12 files, tests green. PR #482 ready to
					review.
				</div>
				<div className="mt-auto flex items-center gap-2 rounded-full border border-border bg-card px-3 py-2">
					<span className="text-[11px] text-muted-foreground">
						Message your agent…
					</span>
					<span className="ml-auto size-5 rounded-full bg-foreground/80" />
				</div>
			</div>
		</AppShell>
	);
}

export function IslandVisual() {
	return (
		<MinimalCard contentClassName="p-4">
			<div className="relative flex min-h-52 items-start justify-center">
				{/* the island overlay */}
				<div className="w-full max-w-xs space-y-2 rounded-2xl border border-border bg-foreground px-4 py-3 text-background shadow-md">
					<div className="flex items-center gap-2">
						<span className="size-2 animate-pulse rounded-full bg-background/80" />
						<span className="font-medium text-[11px]">Ryu noticed</span>
					</div>
					<p className="text-[11px] text-background/80">
						You've been debugging this stack trace for 20 min. Want me to search
						the repo for the root cause?
					</p>
					<div className="flex items-center gap-1.5 pt-1">
						<span className="rounded-full bg-background px-2.5 py-1 text-[10px] text-foreground">
							Yes, dig in
						</span>
						<span className="rounded-full border border-background/30 px-2.5 py-1 text-[10px] text-background/80">
							Dismiss
						</span>
						<span className="ml-auto inline-flex items-center gap-1 text-[10px] text-background/70">
							<span className="size-1.5 animate-pulse rounded-full bg-background/80" />
							listening
						</span>
					</div>
				</div>
			</div>
		</MinimalCard>
	);
}

export function ConnectionsVisual() {
	const apps = [
		{ name: "Gmail", on: true },
		{ name: "Slack", on: true },
		{ name: "Notion", on: true },
		{ name: "GitHub", on: false },
		{ name: "Stripe", on: false },
	];
	return (
		<MinimalCard>
			<div className="space-y-2">
				{apps.map((a) => (
					<div
						className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2"
						key={a.name}
					>
						<div className="flex items-center gap-2.5">
							<div className="size-6 rounded-md border border-border bg-card" />
							<span className="text-foreground/80 text-xs">{a.name}</span>
						</div>
						<span
							className={cn(
								"flex h-4 w-7 items-center rounded-full p-0.5 transition-colors",
								a.on
									? "justify-end bg-foreground"
									: "justify-start bg-foreground/20"
							)}
						>
							<span className="size-3 rounded-full bg-background" />
						</span>
					</div>
				))}
			</div>
		</MinimalCard>
	);
}

export function CloudVisual() {
	const nodes = [
		{ name: "cloud", on: true },
		{ name: "mac-mini", on: true },
		{ name: "raspberry-pi", on: true },
		{ name: "laptop", on: false },
	];
	return (
		<MinimalCard>
			<div className="space-y-3">
				<div className="flex items-center justify-between">
					<span className="font-medium text-foreground text-sm">Nodes</span>
					<span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
						<span className="size-1.5 animate-pulse rounded-full bg-foreground" />
						24/7 · agents that don't sleep
					</span>
				</div>
				<div className="grid grid-cols-2 gap-2">
					{nodes.map((n) => (
						<div
							className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2"
							key={n.name}
						>
							<span
								className={cn(
									"size-1.5 rounded-full",
									n.on ? "bg-foreground" : "bg-foreground/20"
								)}
							/>
							<span className="font-mono text-[11px] text-foreground/80">
								{n.name}
							</span>
						</div>
					))}
				</div>
				<div className="flex items-center gap-2">
					<Node>You</Node>
					<Wire className="flex-1" />
					<Node emphasis>Ryu Cloud</Node>
					<Wire className="flex-1" delays={[0.3, 0.7]} />
					<Node>Fleet</Node>
				</div>
			</div>
		</MinimalCard>
	);
}

export function RedTeamVisual() {
	const rows = [
		{ name: "prompt-injection", verdict: "BLOCKED" },
		{ name: "data-exfiltration", verdict: "BLOCKED" },
		{ name: "tool-abuse", verdict: "BLOCKED" },
		{ name: "jailbreak (BoN)", verdict: "FLAGGED" },
		{ name: "system-prompt-leak", verdict: "BLOCKED" },
	];
	return (
		<Terminal
			lines={[
				{ prompt: true, text: "ryu redteam run --target my-agent" },
				{ text: "running 240 adversarial probes…", muted: true },
			]}
			title="ryu red-team · agent.target"
		>
			<div className="mt-2 space-y-1">
				{rows.map((r) => (
					<div
						className="flex items-center justify-between text-[12px]"
						key={r.name}
					>
						<span className="text-foreground/70">{r.name}</span>
						<span
							className={cn(
								"font-mono text-[11px]",
								r.verdict === "BLOCKED"
									? "text-foreground/50"
									: "text-foreground"
							)}
						>
							{r.verdict}
						</span>
					</div>
				))}
			</div>
		</Terminal>
	);
}

export function DevicesVisual() {
	return (
		<WindowFrame title="ryu devices">
			<div className="flex min-h-52 flex-col items-center justify-center gap-5 rounded-lg bg-muted/30 p-6">
				<div className="relative flex items-center justify-center">
					<span className="absolute size-24 animate-ping rounded-full border border-foreground/10" />
					<span className="absolute size-16 rounded-full border border-foreground/20" />
					<span className="size-10 rounded-full border-2 border-foreground/60" />
				</div>
				<div className="text-center">
					<p className="font-medium text-foreground text-sm">
						Always-aware, on-device
					</p>
					<p className="mt-1 text-[11px] text-muted-foreground">
						Rings · pendants · local AI · coming soon
					</p>
				</div>
			</div>
		</WindowFrame>
	);
}

export function CommandBarVisual() {
	const results = [
		{ icon: "▸", text: "Ask: summarize my unread email", hint: "Enter" },
		{ icon: "⌘", text: "Run agent · triage-issues", hint: "↵" },
		{ icon: "◷", text: "Resume · draft release notes", hint: "" },
		{ icon: "🎙", text: "Dictate a task…", hint: "⌥Space" },
	];
	return (
		<WindowFrame contentClassName="bg-muted/30 p-6" title="desktop">
			<div className="mx-auto max-w-sm overflow-hidden rounded-xl border border-border bg-card shadow-md">
				<div className="flex items-center gap-2 border-border border-b px-3 py-2.5">
					<span className="text-muted-foreground text-xs">⌘</span>
					<span className="text-foreground/80 text-xs">Ask Ryu anything…</span>
					<span className="ml-auto inline-block h-3 w-px animate-pulse bg-foreground/50" />
				</div>
				<div className="p-1.5">
					{results.map((r, i) => (
						<div
							className={cn(
								"flex items-center gap-2.5 rounded-lg px-2.5 py-1.5",
								i === 0 ? "bg-foreground/10" : ""
							)}
							key={r.text}
						>
							<span className="w-4 text-center text-[11px] text-muted-foreground">
								{r.icon}
							</span>
							<span className="text-[11px] text-foreground/80">{r.text}</span>
							{r.hint ? (
								<span className="ml-auto rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
									{r.hint}
								</span>
							) : null}
						</div>
					))}
				</div>
			</div>
		</WindowFrame>
	);
}

export function AgentsAsServiceVisual() {
	const steps = ["Your workflow", "We build it", "Shipped, live"];
	return (
		<WindowFrame title="agents as a service">
			<div className="space-y-4">
				<div className="flex items-center gap-2">
					{steps.map((s, i) => (
						<div className="flex flex-1 items-center gap-2" key={s}>
							<Node emphasis={i === 1}>{s}</Node>
							{i < steps.length - 1 ? <Wire className="flex-1" /> : null}
						</div>
					))}
				</div>
				<div className="rounded-lg border border-border bg-muted/30 p-3">
					<div className="mb-2 flex items-center justify-between">
						<span className="font-medium text-foreground text-xs">
							Build engagement
						</span>
						<span className="rounded-full bg-foreground px-2 py-0.5 text-[10px] text-background">
							Free
						</span>
					</div>
					<div className="space-y-1.5">
						{[
							"Scoped to your workflows",
							"Built on the open Ryu platform",
							"Yours to keep, zero lock-in",
						].map((t) => (
							<div
								className="flex items-center gap-2 text-[11px] text-muted-foreground"
								key={t}
							>
								<span className="size-1.5 rounded-full bg-foreground/40" />
								{t}
							</div>
						))}
					</div>
				</div>
			</div>
		</WindowFrame>
	);
}
