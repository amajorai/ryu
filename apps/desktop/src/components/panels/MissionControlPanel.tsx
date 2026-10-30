// The workspace Mission Control panel: what this conversation actually DID,
// grouped into one card per turn instead of a wall of messages.
//
// The chat transcript answers "what was said". This answers "what changed, and
// why" — the same move a stacked-PR tool makes when it summarises a diff into
// logical changes with a rationale under each, except the rationale here is not
// generated: it is the assistant's own prose from before it touched anything.
// See `lib/mission-control/turn-groups.ts` for why that distinction matters.
//
// Everything is derived client-side from the live message stream, which Core
// also persists into the sealed `parts` column — so the panel reads the same on
// a running turn and on a chat reopened next week, with no fetch, no model call
// and no dependency on the Mission Control app being installed. The app adds
// cross-chat history on top (see `pages/MissionControlPage.tsx`); it is not
// required for this panel to work.

import {
	Alert02Icon,
	ArrowRight01Icon,
	CheckmarkCircle02Icon,
	CodeIcon,
	File01Icon,
	Loading03Icon,
	Search01Icon,
	SparklesIcon,
	UserSharingIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useMemo, useState } from "react";
import {
	buildMissionDigest,
	type MissionCommand,
	type MissionFileTouch,
	type MissionStreamMessage,
	type MissionTodo,
	type MissionTurn,
	type MissionTurnStatus,
} from "@/src/lib/mission-control/turn-groups.ts";

const STATUS_META = {
	ok: {
		className: "text-status-success",
		icon: CheckmarkCircle02Icon,
		label: "Completed",
	},
	failed: {
		className: "text-status-destructive",
		icon: Alert02Icon,
		label: "Hit an error",
	},
	running: {
		className: "text-muted-foreground animate-spin",
		icon: Loading03Icon,
		label: "Still working",
	},
} satisfies Record<
	MissionTurnStatus,
	{ className: string; icon: typeof CheckmarkCircle02Icon; label: string }
>;

const TOUCH_META = {
	create: {
		className: "text-status-success",
		label: "new",
	},
	edit: { className: "text-status-warning", label: "edit" },
	read: { className: "text-muted-foreground", label: "read" },
} satisfies Record<
	MissionFileTouch["kind"],
	{ className: string; label: string }
>;

/** Chips beyond this are collapsed into a "+N" count — a turn that grepped
 *  thirty times should read as one line, not thirty. */
const MAX_CHIPS = 4;

function StatRow({ label, value }: { label: string; value: number }) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="font-medium text-sm tabular-nums">
				{formatCount(value)}
			</span>
			<span className="text-detail text-muted-foreground">{label}</span>
		</div>
	);
}

function ChipList({
	icon,
	items,
	title,
}: {
	icon: typeof Search01Icon;
	items: string[];
	title: string;
}) {
	if (items.length === 0) {
		return null;
	}
	const shown = items.slice(0, MAX_CHIPS);
	const hidden = items.length - shown.length;
	return (
		<div className="flex flex-wrap items-center gap-1">
			<Tooltip>
				<TooltipTrigger
					className="flex size-4 shrink-0 items-center justify-center"
					render={<span />}
				>
					<HugeiconsIcon className="size-3.5" icon={icon} />
				</TooltipTrigger>
				<TooltipContent>{title}</TooltipContent>
			</Tooltip>
			{shown.map((item) => (
				<span
					className="max-w-full truncate rounded-lg bg-muted px-1.5 py-0.5 text-muted-foreground text-xs"
					key={item}
					title={item}
				>
					{item}
				</span>
			))}
			{hidden > 0 && (
				<span className="text-muted-foreground text-xs">+{hidden}</span>
			)}
		</div>
	);
}

function FileRow({ touch }: { touch: MissionFileTouch }) {
	const meta = TOUCH_META[touch.kind];
	return (
		<div className="flex items-center gap-2 py-0.5">
			<span className={cn("w-8 shrink-0 text-xs", meta.className)}>
				{meta.label}
			</span>
			<span className="min-w-0 flex-1 truncate text-xs" title={touch.path}>
				{touch.path}
			</span>
			{touch.count > 1 && (
				<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
					×{formatCount(touch.count) ?? "—"}
				</span>
			)}
		</div>
	);
}

function CommandRow({ command }: { command: MissionCommand }) {
	return (
		<div className="flex items-start gap-2 py-0.5">
			<HugeiconsIcon
				className={cn(
					"mt-0.5 size-3.5 shrink-0",
					command.failed ? "text-status-destructive" : "text-muted-foreground"
				)}
				icon={CodeIcon}
			/>
			<code
				className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs"
				title={command.description ?? command.command}
			>
				{command.command}
			</code>
		</div>
	);
}

/** A labelled prose block. `Why` is the load-bearing one — it is the whole
 *  reason this panel exists — so it gets the accent rule, not a muted aside. */
function ProseBlock({
	accent,
	body,
	label,
}: {
	accent?: boolean;
	body: string;
	label: string;
}) {
	if (body.length === 0) {
		return null;
	}
	return (
		<div
			className={cn(
				"border-l-2 pl-2.5",
				accent ? "border-primary/40" : "border-border"
			)}
		>
			<div className="text-detail text-muted-foreground">{label}</div>
			<p className="whitespace-pre-wrap text-xs leading-relaxed">{body}</p>
		</div>
	);
}

function TurnCard({ turn }: { turn: MissionTurn }) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const status = STATUS_META[turn.status];
	const hasDetail =
		turn.files.length > 0 ||
		turn.shellCommands.length > 0 ||
		turn.searches.length > 0 ||
		turn.web.length > 0 ||
		turn.delegates.length > 0 ||
		turn.thinking.length > 0;

	return (
		<div className="rounded-lg border border-border bg-card/40 p-2.5">
			<div className="flex items-start gap-2">
				<Tooltip>
					<TooltipTrigger
						className="mt-0.5 flex shrink-0 items-center justify-center"
						render={<span />}
					>
						<HugeiconsIcon
							className={cn("size-4", status.className)}
							icon={status.icon}
						/>
					</TooltipTrigger>
					<TooltipContent>{status.label}</TooltipContent>
				</Tooltip>
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-1.5">
						<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
							{turn.index}
						</span>
						<span className="min-w-0 flex-1 font-medium text-xs">
							{turn.headline}
						</span>
					</div>
					{turn.request.length > 0 && (
						<p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
							{turn.request}
						</p>
					)}
				</div>
			</div>

			<div className="mt-2 space-y-2">
				<ProseBlock accent body={turn.rationale} label="Why" />
				<ProseBlock body={turn.outcome} label="Result" />
			</div>

			{hasDetail && (
				<Collapsible onOpenChange={setOpen} open={open}>
					<CollapsibleTrigger
						appearance="mission-summary"
						className="mt-2 flex items-center"
						render={<button type="button" />}
					>
						<HugeiconsIcon
							className={cn(
								"size-3.5 transition-transform",
								open && "rotate-90"
							)}
							icon={ArrowRight01Icon}
						/>
						{open ? tl("Hide what it touched") : tl("Show what it touched")}
					</CollapsibleTrigger>
					<CollapsibleContent className="mt-1.5" spacing="mission-events">
						{turn.thinking.length > 0 && (
							<ProseBlock body={turn.thinking} label="Reasoning" />
						)}
						{turn.files.map((touch) => (
							<FileRow key={`${touch.kind}-${touch.path}`} touch={touch} />
						))}
						{turn.shellCommands.map((command, i) => (
							<CommandRow
								command={command}
								key={`${command.command}-${i.toString()}`}
							/>
						))}
						<ChipList
							icon={Search01Icon}
							items={turn.searches}
							title="Searched for"
						/>
						<ChipList icon={File01Icon} items={turn.web} title="Fetched" />
						<ChipList
							icon={UserSharingIcon}
							items={turn.delegates}
							title="Delegated to a sub-agent"
						/>
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	);
}

function TodoSection({ todos }: { todos: MissionTodo[] }) {
	if (todos.length === 0) {
		return null;
	}
	return (
		<div className="rounded-lg border border-border bg-card/40 p-2.5">
			<div className="mb-1.5 flex items-center gap-1.5">
				<HugeiconsIcon
					className="size-3.5 text-muted-foreground"
					icon={SparklesIcon}
				/>
				<span className="font-medium text-xs">Still to do</span>
				<Badge className="ml-auto" size="compact" variant="secondary">
					{todos.length}
				</Badge>
			</div>
			<ul className="space-y-1">
				{todos.map((todo) => (
					<li className="flex items-start gap-1.5 text-xs" key={todo.content}>
						<span
							aria-hidden="true"
							className={cn(
								"mt-1.5 size-1.5 shrink-0 rounded-full",
								todo.status === "in_progress" ? "bg-primary" : "bg-border"
							)}
						/>
						<span className="min-w-0 flex-1">{todo.content}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * The panel. Renders newest turn first: on a live chat the interesting card is
 * the one still running, and scrolling to the bottom of a hundred-turn thread
 * to find it is the behaviour the transcript already has.
 */
export function MissionControlPanel({
	messages,
}: {
	/** The conversation's message stream. Undefined outside a chat — the tab is
	 *  also reachable from the dock's "+" menu, where there may be none. */
	messages?: MissionStreamMessage[];
}) {
	const digest = useMemo(() => buildMissionDigest(messages ?? []), [messages]);

	if (!messages) {
		return (
			<div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs">
				Open a chat to see what it did here.
			</div>
		);
	}

	if (digest.turns.length === 0) {
		return (
			<div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs">
				Nothing yet — this chat hasn't done any work to summarise.
			</div>
		);
	}

	const ordered = [...digest.turns].reverse();

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="grid shrink-0 grid-cols-4 gap-2 border-border border-b px-3 py-2.5">
				<StatRow label="Turns" value={digest.totals.turns} />
				<StatRow label="Files" value={digest.totals.writes} />
				<StatRow label="Commands" value={digest.totals.commands} />
				<StatRow label="Errors" value={digest.totals.failures} />
			</div>
			<div className="scroll-fade min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
				<TodoSection todos={digest.openTodos} />
				{ordered.map((turn) => (
					<TurnCard key={turn.id} turn={turn} />
				))}
			</div>
		</div>
	);
}
