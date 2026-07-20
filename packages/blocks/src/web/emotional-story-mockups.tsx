import { cn } from "@ryu/ui/lib/utils";
import {
	Check,
	CircleDollarSign,
	FolderOpen,
	ScrollText,
	ShieldCheck,
	X,
} from "lucide-react";
import { AppShell, MinimalCard } from "./mockups.tsx";

function StatusDot({ tone }: { tone: "ok" | "warn" | "bad" | "idle" }) {
	const styles = {
		ok: "bg-success",
		warn: "bg-warning",
		bad: "bg-destructive",
		idle: "bg-foreground/25",
	};
	return (
		<span className={cn("size-1.5 shrink-0 rounded-full", styles[tone])} />
	);
}

/** Generic chatbot: copy-paste, no runs, no governance. */
export function ChatbotOnlyMock() {
	return (
		<MinimalCard contentClassName="space-y-3">
			<div className="ml-auto max-w-[88%] rounded-2xl rounded-tr-sm bg-foreground px-3 py-2 text-[11px] text-background">
				Summarize this PDF and draft the follow-up email
			</div>
			<div className="max-w-[92%] rounded-2xl rounded-tl-sm border border-border bg-muted/40 px-3 py-2 text-[11px] text-foreground/75">
				Here's a summary… (paste into Gmail yourself)
			</div>
			<div className="rounded-lg border border-border border-dashed bg-muted/20 px-3 py-2 text-center text-[10px] text-muted-foreground">
				No audit · no tools · no memory · dies in prod
			</div>
		</MinimalCard>
	);
}

/** Gateway audit — the leak that never happened. */
export function AuditSafetyMock() {
	const rows = [
		{
			label: "SSN in prompt",
			detail: "redacted before egress",
			tone: "warn" as const,
		},
		{
			label: "Tool: read_file",
			detail: "allowlisted · sandboxed",
			tone: "ok" as const,
		},
		{ label: "Budget", detail: "$12 / $200 cap", tone: "ok" as const },
	];
	return (
		<MinimalCard contentClassName="space-y-3">
			<div className="flex items-center gap-2">
				<ShieldCheck className="size-4 text-muted-foreground" />
				<p className="font-medium text-foreground text-xs">Every call logged</p>
			</div>
			{rows.map((row) => (
				<div
					className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2"
					key={row.label}
				>
					<StatusDot tone={row.tone} />
					<div className="min-w-0 flex-1">
						<p className="font-medium text-foreground text-xs">{row.label}</p>
						<p className="text-[10px] text-muted-foreground">{row.detail}</p>
					</div>
				</div>
			))}
		</MinimalCard>
	);
}

/** One-click install — local model, no keys. */
export function InstallLocalMock() {
	const agents = [
		{ name: "Ryu", sub: "Pi + Gateway · default", installed: true },
		{ name: "Claude Code", sub: "opt-in catalog", installed: false },
		{ name: "Codex", sub: "opt-in catalog", installed: false },
	];
	return (
		<MinimalCard contentClassName="space-y-3">
			<div className="flex items-center justify-between rounded-lg bg-success/10 px-3 py-2">
				<span className="text-[11px] text-success">
					gemma-4 running locally · :8080
				</span>
				<span className="font-mono text-[10px] text-success/80">
					0 API keys
				</span>
			</div>
			<div className="space-y-2">
				{agents.map((agent) => (
					<div
						className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2.5"
						key={agent.name}
					>
						<div>
							<p className="font-medium text-foreground text-xs">
								{agent.name}
							</p>
							<p className="text-[10px] text-muted-foreground">{agent.sub}</p>
						</div>
						<span
							className={cn(
								"rounded-md px-2 py-1 font-medium text-[10px]",
								agent.installed
									? "bg-foreground text-background"
									: "border border-border text-foreground/60"
							)}
						>
							{agent.installed ? "Installed" : "Add"}
						</span>
					</div>
				))}
			</div>
		</MinimalCard>
	);
}

/** Demo dies in the room — security questions + folder called later. */
export function DemoDeathMock() {
	const blockers = [
		"Can you prove it's safe?",
		"What will this cost?",
		"Who maintains it?",
	];
	return (
		<AppShell active="Chat" nav={["Chat", "Agents", "Runs", "Spaces"]}>
			<div className="space-y-3">
				<div className="max-w-[90%] rounded-2xl rounded-tl-sm border border-border bg-card px-3 py-2 text-[11px] text-foreground/80">
					Refactored auth. Tests pass on my machine.
				</div>
				<div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3">
					<p className="font-medium text-[11px] text-destructive">
						Security review
					</p>
					<ul className="mt-2 space-y-1.5">
						{blockers.map((q) => (
							<li
								className="flex items-center gap-2 text-[10px] text-foreground/75"
								key={q}
							>
								<X
									className="size-3 shrink-0 text-destructive"
									strokeWidth={2}
								/>
								{q}
							</li>
						))}
					</ul>
				</div>
				<div className="flex items-center gap-2 rounded-lg border border-border border-dashed bg-muted/20 px-3 py-2 text-[10px] text-muted-foreground">
					<FolderOpen className="size-3.5 shrink-0" />
					<span className="font-mono">~/projects/later/</span>
				</div>
			</div>
		</AppShell>
	);
}

/** Governed agent — gateway overview the room can't argue with. */
export function GovernedAgentMock() {
	return (
		<MinimalCard contentClassName="space-y-4">
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-3">
					<div className="flex items-center gap-2">
						<ScrollText className="size-4 text-muted-foreground" />
						<p className="font-medium text-foreground text-xs">Audit</p>
					</div>
					<p className="font-mono text-[10px] text-muted-foreground">
						req_8f2a · logged · allowed
					</p>
					<p className="font-mono text-[10px] text-muted-foreground">
						tool_exec · ghost.snapshot · allowed
					</p>
					<p className="font-mono text-[10px] text-muted-foreground">
						pii_scan · 2 fields redacted
					</p>
				</div>
				<div className="space-y-3">
					<div className="flex items-center gap-2">
						<CircleDollarSign className="size-4 text-muted-foreground" />
						<p className="font-medium text-foreground text-xs">Budget</p>
					</div>
					<p className="text-[11px] text-muted-foreground tabular-nums">
						$48 / $200
					</p>
					<div className="h-2 overflow-hidden rounded-full bg-muted">
						<div className="h-full w-[24%] rounded-full bg-foreground" />
					</div>
					<p className="text-[10px] text-success">Under cap · no surprises</p>
				</div>
			</div>
			<p className="text-center font-medium text-[11px] text-foreground">
				Nobody in the room says no.
			</p>
		</MinimalCard>
	);
}

/** Seven-minute path — install → agent → first real task. */
export function SevenMinuteMock() {
	const steps = [
		{ label: "Download Ryu", done: true },
		{ label: "Pick agent from catalog", done: true },
		{ label: "Send first real task", done: true },
	];
	return (
		<AppShell active="Chat" nav={["Chat", "Agents", "Runs", "Gateway"]}>
			<div className="space-y-3">
				<div className="flex items-center justify-between rounded-lg bg-foreground px-3 py-2 text-background">
					<span className="font-medium text-[11px]">
						7:00 · first run complete
					</span>
					<span className="font-mono text-[10px] text-background/80">
						gateway on
					</span>
				</div>
				<div className="space-y-1.5">
					{steps.map((step) => (
						<div
							className="flex items-center gap-2 text-[10px]"
							key={step.label}
						>
							<Check className="size-3 text-success" strokeWidth={2.5} />
							<span className="text-foreground/80">{step.label}</span>
						</div>
					))}
				</div>
				<div className="ml-auto max-w-[88%] rounded-2xl rounded-tr-sm bg-foreground px-3 py-2 text-[11px] text-background">
					Triage overnight support tickets
				</div>
				<div className="max-w-[92%] rounded-2xl rounded-tl-sm border border-border bg-card px-3 py-2 text-[11px] text-foreground/80">
					12 tickets classified · 3 escalated · draft replies ready
				</div>
			</div>
		</AppShell>
	);
}

/** Still running Monday — the win that sticks. */
export function StillRunningMock() {
	return (
		<AppShell active="Runs" nav={["Chat", "Agents", "Runs", "Audit"]}>
			<div className="space-y-3">
				<div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2">
					<div>
						<p className="font-mono text-foreground text-xs">support-triage</p>
						<p className="text-[10px] text-muted-foreground">
							since Friday · 0 incidents
						</p>
					</div>
					<span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2 py-1 text-[10px] text-success">
						<StatusDot tone="ok" />
						running
					</span>
				</div>
				<div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
					<p className="font-medium text-[10px] text-muted-foreground uppercase tracking-widest">
						Last audit scan
					</p>
					<p className="mt-1 text-foreground text-xs">
						No leaks · budget respected
					</p>
				</div>
				<p className="text-center text-[10px] text-muted-foreground">
					Works with everything. Locked to nothing.
				</p>
			</div>
		</AppShell>
	);
}
