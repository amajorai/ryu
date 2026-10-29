import { cn } from "@ryu/ui/lib/utils";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { CodePane, Node } from "./mockups.tsx";

/* ================================================================== */
/* Feature-row visuals for product pages. Each one shows the single    */
/* claim its row makes, built from the shared mockup primitives.       */
/* ================================================================== */

/**
 * The outlined mock card every framed row visual shares: one border, the card
 * surface, and a minimum height so short mocks still read as an object.
 */
export function MockCard({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex min-h-[200px] w-full flex-col justify-center gap-2 rounded-2xl border border-border bg-card p-5",
				className
			)}
			data-mock-card
		>
			{children}
		</div>
	);
}

/**
 * One borderless status row, shared by the product-page row visuals here and
 * the page-specific visuals in data/products.tsx so they keep one style.
 * `active` adds a quiet ring.
 */
export function StatusRow({
	label,
	value,
	strong,
	active,
	children,
}: {
	label: ReactNode;
	value?: string;
	strong?: boolean;
	active?: boolean;
	children?: ReactNode;
}) {
	return (
		<div
			className={cn(
				"flex items-center justify-between gap-3 rounded-lg bg-background px-4 py-3",
				active && "ring-1 ring-foreground/30"
			)}
		>
			<span className="text-foreground/80 text-sm">{label}</span>
			<span className="flex shrink-0 items-center gap-2">
				{value ? (
					<span
						className={cn(
							"text-sm",
							strong ? "text-foreground" : "text-muted-foreground"
						)}
					>
						{value}
					</span>
				) : null}
				{children}
			</span>
		</div>
	);
}

function Toggle({ on }: { on: boolean }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex h-4 w-7 shrink-0 items-center rounded-full p-0.5",
				on ? "justify-end bg-foreground" : "justify-start bg-foreground/20"
			)}
		>
			<span className="size-3 rounded-full bg-background" />
		</span>
	);
}

function ButtonMock({
	children,
	primary,
}: {
	children: string;
	primary?: boolean;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-8 items-center rounded-full px-3.5 text-sm",
				primary
					? "bg-foreground font-medium text-background"
					: "border border-border text-foreground/80"
			)}
		>
			{children}
		</span>
	);
}

/** An MCP host's config pointing at the published ryu-mcp bridge (agent-integration-guide.mdx). */
export function McpHostConfigVisual() {
	return (
		<CodePane
			code={`{
  "mcpServers": {
    "ryu": {
      "command": "ryu-mcp",
      "args": ["serve"]
    }
  }
}`}
		/>
	);
}

/** A risky action paused for a person's approval, with the drafted message it would send. */
export function ApprovalCardVisual({
	action,
	app,
	preview,
}: {
	action: string;
	app: string;
	/** One readable line of the draft; placeholder bars render without it. */
	preview?: string;
}) {
	return (
		<MockCard>
			<div className="space-y-4">
				<div className="flex items-center justify-between gap-3">
					<span className="text-muted-foreground text-sm">{app}</span>
					<span className="text-foreground text-sm">Needs approval</span>
				</div>
				<p className="font-medium text-base text-foreground">{action}</p>
				<div
					aria-hidden={preview ? undefined : true}
					className="space-y-2 rounded-xl border border-border bg-background p-3"
					data-approval-draft
				>
					{preview ? (
						<p className="text-foreground/80 text-sm">{preview}</p>
					) : (
						<>
							<span className="block h-2 w-11/12 rounded-full bg-foreground/10" />
							<span className="block h-2 w-4/5 rounded-full bg-foreground/10" />
							<span className="block h-2 w-3/5 rounded-full bg-foreground/10" />
						</>
					)}
				</div>
				<div className="flex gap-2">
					<ButtonMock primary>Approve</ButtonMock>
					<ButtonMock>Deny</ButtonMock>
				</div>
			</div>
		</MockCard>
	);
}

/** Agents, workflows, tools, and skills share one input → run → output contract. */
export function SdkContractVisual() {
	const kinds = ["Agent", "Workflow", "Tool", "Skill"];
	return (
		<div className="flex w-full flex-col items-center gap-2 px-1 py-2">
			<div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4">
				{kinds.map((kind) => (
					<Node key={kind}>{kind}</Node>
				))}
			</div>
			<span aria-hidden="true" className="h-4 w-px bg-border" />
			<Node className="w-40 font-mono" emphasis>
				run(input)
			</Node>
			<span aria-hidden="true" className="h-4 w-px bg-border" />
			<Node className="w-40 font-mono">output</Node>
		</div>
	);
}

/** A coding run's worktree diff. */
export function DiffReviewVisual() {
	const lines = [
		{ sign: "-", text: "const limit = 10;" },
		{ sign: "+", text: "const limit = config.pageSize;" },
		{ sign: "+", text: "if (limit < 1) throw new RangeError();" },
	];
	return (
		<div className="w-full px-1 py-2">
			<div className="space-y-1 overflow-x-auto rounded-lg bg-foreground/[0.03] p-3 font-mono text-xs">
				{lines.map((line) => (
					<p
						className={cn(
							"whitespace-pre",
							line.sign === "+" ? "text-foreground" : "text-muted-foreground"
						)}
						key={line.text}
					>
						{line.sign} {line.text}
					</p>
				))}
			</div>
		</div>
	);
}

/** The three network modes a Box can run with. */
export function BoxNetworkVisual() {
	const modes = [
		{ label: "No network", value: "Offline", on: false },
		{ label: "Allowlist", value: "Up to 64 hosts", on: true },
		{ label: "Filtered public access", value: "No private ranges", on: false },
	];
	return (
		<div className="w-full space-y-2 px-1 py-2">
			{modes.map((mode) => (
				<StatusRow
					active={mode.on}
					key={mode.label}
					label={
						<span className="flex items-center gap-2">
							<span
								aria-hidden="true"
								className={cn(
									"size-2.5 rounded-full border",
									mode.on
										? "border-foreground bg-foreground"
										: "border-foreground/30"
								)}
							/>
							{mode.label}
						</span>
					}
					value={mode.value}
				/>
			))}
		</div>
	);
}

/**
 * Notify's retry ladder: waits of 30 s × 5ⁿ, capped at 30 minutes, five
 * attempts. Labels are cumulative time since the first attempt.
 */
export function RetryTimelineVisual() {
	const attempts = [
		{ at: "Now", result: "Failed" },
		{ at: "+30 s", result: "Failed" },
		{ at: "+3 min", result: "Failed" },
		{ at: "+15.5 min", result: "Delivered" },
	];
	return (
		<ol className="w-full space-y-2 px-1 py-2">
			{attempts.map((attempt, index) => (
				<li key={attempt.at}>
					<StatusRow
						label={`Attempt ${index + 1} · ${attempt.at}`}
						strong={attempt.result === "Delivered"}
						value={attempt.result}
					/>
				</li>
			))}
		</ol>
	);
}

/** One chat thread with several agents answering side by side. */
export function CouncilVisual() {
	const agents = ["Research", "Finance"];
	return (
		<div className="w-full space-y-3 px-1 py-2">
			<p className="ml-auto w-fit rounded-lg bg-foreground/5 px-3 py-2 text-foreground/80 text-sm">
				@Research @Finance
			</p>
			{/* One reply after another, as the thread shows them. */}
			<div className="space-y-2">
				{agents.map((agent) => (
					<div
						className="space-y-3 rounded-lg border border-border p-3"
						key={agent}
					>
						<p className="font-medium text-foreground text-sm">{agent}</p>
						<div aria-hidden="true" className="space-y-2">
							<span className="block h-2 w-11/12 rounded-full bg-foreground/10" />
							<span className="block h-2 w-3/5 rounded-full bg-foreground/10" />
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

/** Island's three consent switches (apps/island/src/shared/consent.ts). */
export function IslandConsentVisual() {
	const switches = [
		{ label: "Chat", value: "On", on: true },
		{ label: "Screen reading", value: "Ask first", on: false },
		{ label: "Suggestions", value: "Ask first", on: false },
	];
	return (
		<div className="w-full space-y-2 px-1 py-2">
			{switches.map((item) => (
				<StatusRow key={item.label} label={item.label} value={item.value}>
					<Toggle on={item.on} />
				</StatusRow>
			))}
		</div>
	);
}

/** The browser extension's quick actions on the current page. */
export function PageActionsVisual() {
	const actions = [
		"Summarize this page",
		"Ask about selection",
		"Save to a Space",
	];
	return (
		<div className="w-full space-y-3 px-1 py-2">
			<div className="space-y-2 rounded-lg border border-border p-3">
				<span className="block h-2 w-2/3 rounded-full bg-foreground/15" />
				<span className="block h-2 w-full rounded-full bg-foreground/10" />
				<span className="block h-2 w-5/6 rounded-full bg-foreground/30" />
				<span className="block h-2 w-3/4 rounded-full bg-foreground/10" />
			</div>
			<div className="flex flex-wrap gap-2">
				{actions.map((action, index) => (
					<ButtonMock key={action} primary={index === 0}>
						{action}
					</ButtonMock>
				))}
			</div>
		</div>
	);
}

/** The permission sheet shown before an app is installed. */
export function PermissionGrantVisual() {
	const grants = [
		"Open web pages",
		"Read files you share",
		"Call allowed tools",
	];
	return (
		<div className="mx-auto w-full max-w-sm space-y-4 self-center px-1 py-4">
			<p className="font-medium text-foreground text-sm">This app asks to</p>
			<ul className="space-y-3">
				{grants.map((grant) => (
					<li
						className="flex items-center justify-between gap-3 text-foreground/80 text-sm"
						key={grant}
					>
						{grant}
						<Toggle on />
					</li>
				))}
			</ul>
			<div className="flex gap-2">
				<ButtonMock primary>Install</ButtonMock>
				<ButtonMock>Cancel</ButtonMock>
			</div>
		</div>
	);
}

/** One installed plugin: enabled, with its permissions checked. */
export function PluginLifecycleVisual() {
	return (
		<div className="w-full px-1 py-2">
			<StatusRow
				active
				label={
					<span aria-hidden="true" className="flex items-center gap-3">
						<span className="size-6 shrink-0 rounded-md bg-foreground/10" />
						<span className="block h-2 w-28 rounded-full bg-foreground/15" />
					</span>
				}
			>
				<Toggle on />
			</StatusRow>
			<p className="flex items-center gap-2 px-4 pt-3 text-muted-foreground text-xs">
				<Check aria-hidden="true" className="size-3.5 text-foreground" />
				Permissions checked
			</p>
		</div>
	);
}
