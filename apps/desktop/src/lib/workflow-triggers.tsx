// apps/desktop/src/lib/workflow-triggers.tsx
//
// Shared display helpers for a workflow's triggers (its inputs) and terminal
// nodes (its outputs): an icon + label per trigger kind, a Composio-toolkit icon
// map, a best-effort next-run estimate, and two small presentational pieces —
// `WorkflowTriggerIcons` (a sidebar row's trigger glyphs with a hover tooltip
// that surfaces the next run) and `WorkflowFlowStrip` (a Library card preview:
// trigger icons → output-node icons).
//
// Next-run is intentionally best-effort. Core exposes no `nextRunAt`, and we do
// not ship a cron engine for a cosmetic touch, so we estimate only fixed `every`
// intervals (anchor + interval, rolled forward past now) and fall back to the
// raw cron expression for cron schedules. The `every` anchor is a schedule job's
// `lastRunAt` when one exists, otherwise the workflow's own cadence is shown
// without an exact time.

import {
	ArrowRight01Icon,
	BotIcon,
	Calendar04Icon,
	CircleIcon,
	Clock01Icon,
	CodeIcon,
	Database01Icon,
	GitBranchIcon,
	GoogleIcon,
	Mail01Icon,
	Note01Icon,
	PlayIcon,
	PlugSocketIcon,
	RecordIcon,
	RepeatIcon,
	Shield01Icon,
	WebhookIcon,
	WorkflowSquare01Icon,
	ZapIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import type { ScheduledJob } from "@/src/lib/api/schedules.ts";
import type {
	WorkflowEdge,
	WorkflowNode,
	WorkflowTrigger,
} from "@/src/lib/api/workflows.ts";

// ── Trigger (input) metadata ────────────────────────────────────────────────

/** Composio toolkit slug → glyph. Only well-known toolkits with a confirmed
 * Hugeicon are mapped; everything else falls back to the generic Composio bolt.
 * Slugs are lower-cased before lookup so `Gmail`/`GMAIL` both resolve. */
const COMPOSIO_TOOLKIT_ICONS: Record<string, IconSvgElement> = {
	gmail: Mail01Icon,
	googlemail: Mail01Icon,
	googlecalendar: Calendar04Icon,
	google_calendar: Calendar04Icon,
	calendar: Calendar04Icon,
	google: GoogleIcon,
	googledrive: GoogleIcon,
	googledocs: GoogleIcon,
	googlesheets: GoogleIcon,
};

/** Icon + human label for a single trigger. Manual triggers are the default and
 * carry no external event, so callers usually skip rendering them. */
export function triggerMeta(trigger: WorkflowTrigger): {
	icon: IconSvgElement;
	label: string;
} {
	switch (trigger.type) {
		case "schedule":
			return { icon: Clock01Icon, label: "Schedule" };
		case "webhook":
			return { icon: WebhookIcon, label: "Webhook" };
		case "composio": {
			const slug = trigger.toolkit.toLowerCase();
			return {
				icon: COMPOSIO_TOOLKIT_ICONS[slug] ?? ZapIcon,
				label: trigger.toolkit || "Composio event",
			};
		}
		default:
			return { icon: PlayIcon, label: "Manual" };
	}
}

// ── Node (output) metadata ──────────────────────────────────────────────────

/** Node-kind → glyph, mirroring the workflows-app canvas palette
 * (`packages/workflows-app/src/WorkflowCanvas.tsx`) so a card preview reads the
 * same as the canvas. Unmapped kinds fall back to a plain dot. */
const NODE_KIND_ICONS: Record<string, IconSvgElement> = {
	input: ArrowRight01Icon,
	output: CircleIcon,
	prompt: BotIcon,
	condition: GitBranchIcon,
	transform: CodeIcon,
	set_state: Database01Icon,
	tool: ZapIcon,
	webhook: WebhookIcon,
	delay: Clock01Icon,
	sub_workflow: WorkflowSquare01Icon,
	agent_delegate: CircleIcon,
	note: Note01Icon,
	while: RepeatIcon,
	guardrails: Shield01Icon,
	recipe: RecordIcon,
	ghost_action: ZapIcon,
	agent: BotIcon,
	skill: PlugSocketIcon,
	mcp: PlugSocketIcon,
	plugin: PlugSocketIcon,
};

function nodeKindIcon(type: string): IconSvgElement {
	return NODE_KIND_ICONS[type] ?? CircleIcon;
}

/** Terminal nodes = nodes whose id never appears as any edge's `from` (nothing
 * downstream). These are the workflow's outputs. Falls back to any explicit
 * `output` node, then to the last-declared node, so the strip is never empty. */
function terminalNodes(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[]
): WorkflowNode[] {
	if (nodes.length === 0) {
		return [];
	}
	const hasOutgoing = new Set(edges.map((e) => e.from));
	const terminals = nodes.filter((n) => !hasOutgoing.has(n.id));
	if (terminals.length > 0) {
		return terminals;
	}
	const explicit = nodes.filter((n) => n.type === "output");
	if (explicit.length > 0) {
		return explicit;
	}
	return [nodes.at(-1) as WorkflowNode];
}

// ── Next-run estimate (best-effort, `every` only) ───────────────────────────

const INTERVAL_PATTERN = /^(\d+)\s*([smhd])$/;
const UNIT_MS: Record<string, number> = {
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

/** Parse a fixed interval like `"5m"`, `"1h"`, `"1d"` into milliseconds. */
function intervalMs(value: string): number | null {
	const match = INTERVAL_PATTERN.exec(value.trim());
	if (!match) {
		return null;
	}
	return Number(match[1]) * UNIT_MS[match[2]];
}

/** Compact relative time until `target` (e.g. "in 12m", "in 3h", "in 2d"). */
function relativeUntil(target: number, now: number): string {
	const ms = target - now;
	if (ms <= 0) {
		return "now";
	}
	if (ms < UNIT_MS.h) {
		return `in ${Math.max(1, Math.round(ms / UNIT_MS.m))}m`;
	}
	if (ms < UNIT_MS.d) {
		return `in ${Math.round(ms / UNIT_MS.h)}h`;
	}
	return `in ${Math.round(ms / UNIT_MS.d)}d`;
}

/**
 * A one-line tooltip describing when a trigger fires. For `every` schedules we
 * estimate the next run from the job's `lastRunAt` (or now) plus the interval;
 * for cron we surface the raw expression; webhook/composio/manual describe the
 * source. Returns null when there is nothing useful to say.
 */
export function triggerTooltip(
	trigger: WorkflowTrigger,
	job: ScheduledJob | null
): string | null {
	switch (trigger.type) {
		case "schedule": {
			if (trigger.every) {
				const step = intervalMs(trigger.every);
				if (step) {
					const now = Date.now();
					const anchor = job?.lastRunAt
						? new Date(job.lastRunAt).getTime()
						: now;
					// Roll the anchor forward to the first fire strictly after now.
					const elapsed = now - anchor;
					const bumps = elapsed >= 0 ? Math.floor(elapsed / step) + 1 : 0;
					const next = anchor + bumps * step;
					return `Runs every ${trigger.every} · next ${relativeUntil(next, now)}`;
				}
				return `Runs every ${trigger.every}`;
			}
			if (trigger.cron) {
				return `Cron: ${trigger.cron}`;
			}
			return "Scheduled";
		}
		case "webhook":
			return "Runs on incoming webhook";
		case "composio":
			return `${trigger.toolkit || "Composio"} · ${trigger.trigger_slug || "event"}`;
		default:
			return "Runs manually";
	}
}

/** Find the schedule job Core mints for a workflow (deterministic id prefix,
 * matching the workflows-app `TriggerConfig`'s `ScheduleStatus`). */
export function scheduleJobFor(
	workflowId: string,
	jobs: ScheduledJob[]
): ScheduledJob | null {
	if (!workflowId) {
		return null;
	}
	const prefix = `wf-sched-${workflowId}-`;
	return jobs.find((j) => j.id.startsWith(prefix)) ?? null;
}

// ── Presentational pieces ───────────────────────────────────────────────────

/**
 * A row of trigger glyphs for a workflow, each wrapped in a tooltip that names
 * the trigger and (for schedules) estimates the next run. Manual-only workflows
 * render nothing — manual is the implicit default and needs no badge.
 */
export function WorkflowTriggerIcons({
	triggers,
	job = null,
	className,
}: {
	triggers: WorkflowTrigger[];
	job?: ScheduledJob | null;
	className?: string;
}) {
	const shown = triggers.filter((t) => t.type !== "manual");
	if (shown.length === 0) {
		return null;
	}
	return (
		<span className={className}>
			{shown.map((trigger, i) => {
				const { icon, label } = triggerMeta(trigger);
				const tip = triggerTooltip(trigger, job) ?? label;
				return (
					<Tooltip key={`${trigger.type}-${i}`}>
						<TooltipTrigger
							render={
								<span className="inline-flex items-center">
									<HugeiconsIcon
										className="size-3.5 text-muted-foreground/80"
										icon={icon}
									/>
								</span>
							}
						/>
						<TooltipContent>{tip}</TooltipContent>
					</Tooltip>
				);
			})}
		</span>
	);
}

/**
 * A compact "input → output" strip for a Library workflow card: the trigger
 * glyphs, an arrow, then the terminal-node glyphs. Purely visual (no tooltips),
 * so it stays quiet inside a card. Manual-only workflows show a run glyph on the
 * input side so the arrow always has a left-hand anchor.
 */
export function WorkflowFlowStrip({
	triggers,
	nodes,
	edges,
	className,
}: {
	triggers: WorkflowTrigger[];
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
	className?: string;
}) {
	const inputs = triggers.filter((t) => t.type !== "manual");
	const outputs = terminalNodes(nodes, edges).slice(0, 4);
	const inputIcons =
		inputs.length > 0 ? inputs.map((t) => triggerMeta(t).icon) : [PlayIcon];
	return (
		<span
			className={`inline-flex items-center gap-1 text-muted-foreground ${className ?? ""}`}
		>
			{inputIcons.map((icon, i) => (
				<HugeiconsIcon className="size-3.5" icon={icon} key={`in-${i}`} />
			))}
			<HugeiconsIcon
				className="size-3 shrink-0 text-muted-foreground/50"
				icon={ArrowRight01Icon}
			/>
			{outputs.length > 0 ? (
				outputs.map((node, i) => (
					<HugeiconsIcon
						className="size-3.5"
						icon={nodeKindIcon(node.type)}
						key={`out-${node.id ?? i}`}
					/>
				))
			) : (
				<HugeiconsIcon className="size-3.5" icon={CircleIcon} />
			)}
		</span>
	);
}
