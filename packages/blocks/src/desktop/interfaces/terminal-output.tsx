import { cn } from "@ryu/ui/lib/utils";
import {
	INTERFACE_PROTOCOL_VERSION,
	TERMINAL_HELP,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { Fragment, type ReactNode } from "react";
import { compactAge } from "./interface-renderer.ts";
import {
	TERMINAL_STATUS_GLYPHS,
	TERMINAL_STATUS_WORDS,
	type TerminalAgentRow,
	type TerminalCounts,
	type TerminalThreadRow,
} from "./terminal-model.ts";

export type TerminalTone =
	| "default"
	| "error"
	| "muted"
	| "primary"
	| "strong"
	| "success";

/** What a clickable piece of output does. */
export type TerminalAction =
	| { kind: "fill"; value: string }
	| { kind: "open"; threadId: string };

export interface TerminalSegment {
	action?: TerminalAction;
	/** Accessible name for an actionable segment. */
	label?: string;
	text: string;
	tone?: TerminalTone;
}

export type TerminalEntry =
	| { id: number; kind: "agents"; rows: TerminalAgentRow[] }
	| { id: number; kind: "banner" }
	| { id: number; kind: "command"; prompt: string; text: string }
	| { id: number; kind: "help" }
	| {
			id: number;
			kind: "line";
			segments: TerminalSegment[];
			/** Printed without a command (live notices, clicks): starts its own block. */
			standalone?: boolean;
	  }
	| {
			filter: ThreadStatus | "all";
			id: number;
			kind: "threads";
			now: number;
			rows: TerminalThreadRow[];
	  };

export const TONE_CLASS: Record<TerminalTone, string> = {
	default: "text-foreground",
	error: "text-destructive",
	muted: "text-muted-foreground",
	primary: "text-primary",
	strong: "font-medium text-foreground",
	success: "text-success",
};

/**
 * Tone of a status word. Your-turn and working never share a tone, so they
 * stay apart in themes where primary and success are the same hue.
 */
export const STATUS_TONE: Record<ThreadStatus, TerminalTone> = {
	attention: "error",
	quiet: "muted",
	waiting: "muted",
	working: "success",
	"your-turn": "default",
};

/** Tone of the glyph in front of a status word. */
export const STATUS_GLYPH_TONE: Record<ThreadStatus, TerminalTone> = {
	attention: "error",
	quiet: "muted",
	waiting: "muted",
	working: "success",
	"your-turn": "primary",
};

const LINK_CLASS =
	"rounded-xs underline-offset-4 outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring";

type RunAction = (action: TerminalAction) => void;

function ActionText({
	children,
	className,
	label,
	onAction,
	action,
}: {
	action: TerminalAction;
	children: ReactNode;
	className?: string;
	label: string;
	onAction: RunAction;
}) {
	return (
		<button
			aria-label={label}
			className={cn(LINK_CLASS, "text-left", className)}
			onClick={() => onAction(action)}
			type="button"
		>
			{children}
		</button>
	);
}

/**
 * A status glyph in a fixed 1ch cell plus a 1ch gap, so the word after it
 * always starts on the same column whatever the glyph's advance.
 */
export function StatusGlyph({ status }: { status: ThreadStatus }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"mr-[1ch] inline-block w-[1ch] text-center align-[0.05em] text-[13px] leading-none",
				TONE_CLASS[STATUS_GLYPH_TONE[status]]
			)}
		>
			{TERMINAL_STATUS_GLYPHS[status]}
		</span>
	);
}

/** A status glyph and word, toned so status never relies on color alone. */
export function TerminalStatus({ status }: { status: ThreadStatus }) {
	return (
		<>
			<StatusGlyph status={status} />
			<span className={TONE_CLASS[STATUS_TONE[status]]}>
				{TERMINAL_STATUS_WORDS[status]}
			</span>
		</>
	);
}

/**
 * A muted line of `·`-separated hints. Each separator travels with the item
 * after it, so a wrapped line never ends on a dangling dot.
 */
function HintLine({
	className,
	parts,
}: {
	className?: string;
	parts: readonly string[];
}) {
	return (
		<p className={cn("text-muted-foreground", className)}>
			{parts.map((part, index) => (
				<Fragment key={part}>
					{index > 0 ? " " : null}
					<span className="whitespace-nowrap">
						{index > 0 ? "· " : null}
						{part}
					</span>
				</Fragment>
			))}
		</p>
	);
}

function plural(count: number, word: string) {
	return `${count} ${count === 1 ? word : `${word}s`}`;
}

/** How many waiting threads the start-up banner prints. */
export const BANNER_ROWS = 5;

/** The banner's hint line; a capped list reads as truncation, not a count. */
function bannerSummary(
	counts: TerminalCounts,
	needsYou: readonly TerminalThreadRow[]
): string[] {
	const more = counts.needsYou - needsYou.length;
	// The banner stays live in scrollback while `open <n>` resolves against
	// the latest `ls`, so point at the clickable rows instead of a number.
	// The hidden rows mix attention and your-turn threads; only a plain `ls`
	// (most urgent first) lists both.
	return more > 0
		? [`+${more} more`, "ls for all", "click a row to open"]
		: ["click a row to open", "ls for all"];
}

/** The start-up wordmark, drawn in box characters like a shell's motd. */
const WORDMARK = [
	"████▄  █   █  █   █",
	"█   █   █ █   █   █",
	"████▀    █    █   █",
	"█  ▀▄    █    █   █",
	"█   █    █    ▀███▀",
].join("\n");

/** Theme colour chips under the system summary, as a fetch tool prints. */
const SWATCHES = [
	"bg-foreground",
	"bg-muted-foreground",
	"bg-primary",
	"bg-success",
	"bg-destructive",
	"bg-border",
] as const;

function SectionLabel({ children }: { children: string }) {
	return (
		<p aria-hidden="true" className="pb-1 text-muted-foreground">
			<span className="text-primary">#</span> {children}
		</p>
	);
}

function Banner({
	agents,
	counts,
	loading,
	needsYou,
	now,
	onAction,
}: {
	agents: TerminalAgentRow[];
	counts: TerminalCounts;
	loading: boolean;
	needsYou: TerminalThreadRow[];
	now: number;
	onAction: RunAction;
}) {
	let body: ReactNode;
	if (loading) {
		body = <p className="text-muted-foreground">loading agents and threads…</p>;
	} else if (counts.threads === 0) {
		body = <ThreadTable filter="all" now={now} onAction={onAction} rows={[]} />;
	} else if (needsYou.length === 0) {
		body = <HintLine parts={["nothing needs you", "ls to list threads"]} />;
	} else {
		body = (
			<>
				<SectionLabel>needs you</SectionLabel>
				<ThreadTable
					caption="Threads that need you"
					filter="all"
					now={now}
					onAction={onAction}
					rows={needsYou}
					summary={bannerSummary(counts, needsYou)}
				/>
			</>
		);
	}
	const stats: { label: string; tone: TerminalTone; value: number }[] = [
		{ label: "working", tone: "success", value: counts.working },
		{ label: "need you", tone: "primary", value: counts.needsYou },
		{
			label: "attention",
			tone: counts.attention > 0 ? "error" : "muted",
			value: counts.attention,
		},
	];
	return (
		<div className="flex flex-col gap-5">
			<div className="flex items-start gap-[4ch]">
				<pre
					aria-hidden="true"
					className="@2xl/terminal-log:block hidden shrink-0 pt-1 font-mono text-primary leading-none"
				>
					{WORDMARK}
				</pre>
				<div className="min-w-0">
					<p>
						<span className="font-medium text-foreground">Ryu terminal</span>
						<span className="text-muted-foreground">
							{"  "}v{INTERFACE_PROTOCOL_VERSION}
						</span>
					</p>
					<p aria-hidden="true" className="text-muted-foreground">
						{"─".repeat(22)}
					</p>
					{loading ? null : (
						<>
							<HintLine
								parts={[
									plural(counts.agents, "agent"),
									plural(counts.threads, "thread"),
									"help for commands",
								]}
							/>
							<p className="flex flex-wrap gap-x-[3ch]">
								{stats.map((stat) => (
									<span className="whitespace-nowrap" key={stat.label}>
										<span className={TONE_CLASS[stat.tone]}>{stat.value}</span>{" "}
										<span className="text-muted-foreground">{stat.label}</span>
									</span>
								))}
							</p>
							<p aria-hidden="true" className="flex gap-1 pt-2">
								{SWATCHES.map((swatch) => (
									<span
										className={cn("h-3 w-[2ch] rounded-xs", swatch)}
										key={swatch}
									/>
								))}
							</p>
						</>
					)}
				</div>
			</div>
			<div>{body}</div>
			{loading || agents.length === 0 ? null : (
				<div>
					<SectionLabel>agents</SectionLabel>
					<AgentTable onAction={onAction} rows={agents} />
				</div>
			)}
		</div>
	);
}

/** Key bindings of the prompt, listed under `help`. */
export const TERMINAL_KEYS: readonly { usage: string; summary: string }[] = [
	{ summary: "Browse command history", usage: "↑↓" },
	{ summary: "Complete a command, @handle, or thread", usage: "tab" },
	{ summary: "Clear the screen", usage: "ctrl-l" },
	{ summary: "Clear the line", usage: "ctrl-u" },
	{ summary: "Cancel the line", usage: "ctrl-c" },
	{ summary: "Close the open thread", usage: "esc" },
];

/** Usage column width: the longest usage plus a 4ch gap, shared by both groups. */
const HELP_USAGE_WIDTH = "w-[26ch]";

function HelpGroup({
	caption,
	heading,
	rows,
}: {
	caption: string;
	heading?: string;
	rows: readonly { usage: string; summary: string }[];
}) {
	return (
		<table className="table-fixed border-separate border-spacing-0">
			<caption className="sr-only">{caption}</caption>
			<colgroup>
				<col className={HELP_USAGE_WIDTH} />
				<col />
			</colgroup>
			<thead className={heading ? undefined : "sr-only"}>
				<tr className="text-muted-foreground">
					<th className="text-left font-normal" scope="col">
						{heading ?? "Command"}
					</th>
					<th className="text-left font-normal" scope="col">
						{heading ? null : "What it does"}
					</th>
				</tr>
			</thead>
			<tbody>
				{rows.map((row) => (
					<tr key={row.usage}>
						<td className="whitespace-nowrap pr-[2ch] align-top text-foreground">
							{row.usage}
						</td>
						<td className="text-muted-foreground">{row.summary}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function HelpTable() {
	return (
		<div className="flex flex-col gap-3">
			<HelpGroup
				caption="Terminal commands"
				heading="commands"
				rows={TERMINAL_HELP}
			/>
			<HelpGroup caption="Key bindings" heading="keys" rows={TERMINAL_KEYS} />
		</div>
	);
}

/** Row hover reaches 1ch past the text so the text stays on the block gutter. */
const ROW_TABLE_CLASS =
	"-mx-[1ch] w-[calc(100%+2ch)] table-fixed border-separate border-spacing-0";
const ROW_CLASS =
	"relative transition-colors duration-100 hover:bg-muted motion-reduce:transition-none";

function ThreadTable({
	caption,
	filter,
	now,
	onAction,
	rows,
	summary,
}: {
	caption?: string;
	filter: ThreadStatus | "all";
	now: number;
	onAction: RunAction;
	rows: TerminalThreadRow[];
	/** Replaces the default count line under the table. */
	summary?: readonly string[];
}) {
	if (rows.length === 0) {
		return (
			<p className="text-muted-foreground">
				{filter === "all"
					? "no threads yet · new <message> or @agent <message>"
					: `no ${TERMINAL_STATUS_WORDS[filter]} threads · ls to see all`}
			</p>
		);
	}
	return (
		<div>
			<table className={ROW_TABLE_CLASS}>
				<caption className="sr-only">
					{caption ??
						(filter === "all"
							? "Threads"
							: `${TERMINAL_STATUS_WORDS[filter]} threads`)}
				</caption>
				<thead>
					<tr className="text-muted-foreground">
						<th className="w-[5ch] pl-[1ch] text-left font-normal" scope="col">
							#
						</th>
						<th className="w-[13ch] text-left font-normal" scope="col">
							status
						</th>
						<th
							className="@md/terminal-log:table-cell hidden w-[14ch] text-left font-normal"
							scope="col"
						>
							agent
						</th>
						<th className="w-[5ch] text-left font-normal" scope="col">
							age
						</th>
						<th className="pr-[1ch] text-left font-normal" scope="col">
							title
						</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr className={ROW_CLASS} key={row.threadId}>
							<td className="pl-[1ch] text-muted-foreground tabular-nums">
								{row.number}
							</td>
							<td className="truncate pr-[1ch]">
								<TerminalStatus status={row.status} />
							</td>
							<td className="@md/terminal-log:table-cell hidden truncate pr-[1ch] text-muted-foreground">
								{row.agentLabel}
							</td>
							<td className="text-muted-foreground tabular-nums">
								{compactAge(row.updatedAt, now)}
							</td>
							<td className="truncate pr-[1ch]">
								{/* The ::after overlay makes the whole row the click target. */}
								<ActionText
									action={{ kind: "open", threadId: row.threadId }}
									className="block max-w-full text-foreground after:absolute after:inset-0"
									label={`Open thread ${row.number}: ${row.title}${row.pinned ? " (pinned)" : ""}`}
									onAction={onAction}
								>
									<span className="flex min-w-0">
										<span className="truncate">{row.title}</span>
										{row.pinned ? (
											<span className="shrink-0 whitespace-pre text-muted-foreground">
												{"  pinned"}
											</span>
										) : null}
									</span>
								</ActionText>
							</td>
						</tr>
					))}
				</tbody>
			</table>
			<HintLine
				className="pt-2"
				parts={summary ?? [plural(rows.length, "thread"), "open <n>"]}
			/>
		</div>
	);
}

function AgentTable({
	onAction,
	rows,
}: {
	onAction: RunAction;
	rows: TerminalAgentRow[];
}) {
	if (rows.length === 0) {
		return (
			<p className="text-muted-foreground">
				no agents yet · create one in Ryu, then @name &lt;message&gt;
			</p>
		);
	}
	return (
		<div>
			<table className={ROW_TABLE_CLASS}>
				<caption className="sr-only">Agents</caption>
				<colgroup>
					<col className="w-[14ch]" />
					<col className="w-[13ch]" />
					<col className="w-[9ch]" />
					<col className="w-[10ch]" />
					<col />
				</colgroup>
				<thead>
					<tr className="text-muted-foreground">
						<th className="pl-[1ch] text-left font-normal" scope="col">
							agent
						</th>
						<th className="text-left font-normal" scope="col">
							status
						</th>
						<th className="text-left font-normal" scope="col">
							threads
						</th>
						<th className="whitespace-nowrap text-left font-normal" scope="col">
							need you
						</th>
						<th
							className="@md/terminal-log:table-cell hidden pr-[1ch] text-left font-normal"
							scope="col"
						>
							about
						</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr className={ROW_CLASS} key={row.agentId}>
							<td className="truncate pr-[1ch] pl-[1ch]">
								<ActionText
									action={{ kind: "fill", value: `${row.handle} ` }}
									className="block max-w-full text-foreground after:absolute after:inset-0"
									label={`Message ${row.name}`}
									onAction={onAction}
								>
									<span className="block truncate">{row.handle}</span>
								</ActionText>
							</td>
							<td className="truncate pr-[1ch]">
								<StatusGlyph
									status={row.status === "working" ? "working" : "waiting"}
								/>
								<span
									className={
										row.status === "working"
											? "text-success"
											: "text-muted-foreground"
									}
								>
									{row.status}
								</span>
							</td>
							<td className="tabular-nums">{row.threadCount}</td>
							<td
								className={cn(
									"tabular-nums",
									row.needsYou > 0 ? "text-foreground" : "text-muted-foreground"
								)}
							>
								{row.needsYou}
							</td>
							<td className="@md/terminal-log:table-cell hidden truncate pr-[1ch] text-muted-foreground">
								{row.description || "-"}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			<HintLine
				className="pt-2"
				parts={[plural(rows.length, "agent"), "@handle <message>"]}
			/>
		</div>
	);
}

function Line({
	onAction,
	segments,
}: {
	onAction: RunAction;
	segments: TerminalSegment[];
}) {
	return (
		<p className="whitespace-pre-wrap break-words">
			{segments.map((segment, index) => {
				const tone = TONE_CLASS[segment.tone ?? "default"];
				const key = `${index}:${segment.text}`;
				return segment.action ? (
					<ActionText
						action={segment.action}
						className={tone}
						key={key}
						label={segment.label ?? segment.text}
						onAction={onAction}
					>
						{segment.text}
					</ActionText>
				) : (
					<span className={tone} key={key}>
						{segment.text}
					</span>
				);
			})}
		</p>
	);
}

/** A run of scrollback shown as one Warp-style block. */
export interface TerminalBlock {
	entries: TerminalEntry[];
	id: number;
	/** Whether the block starts with the command that produced it. */
	kind: "banner" | "command" | "notice";
}

function startsBlock(
	entry: TerminalEntry,
	previous: TerminalEntry | undefined
) {
	if (entry.kind === "banner" || entry.kind === "command") {
		return true;
	}
	if (entry.kind === "line" && entry.standalone) {
		// Consecutive notices share one block.
		return !(previous?.kind === "line" && previous.standalone);
	}
	return previous === undefined;
}

/**
 * Group scrollback into blocks: a command with its output, the banner, or a
 * run of notices printed without a command.
 */
export function groupTerminalBlocks(
	entries: readonly TerminalEntry[]
): TerminalBlock[] {
	const blocks: TerminalBlock[] = [];
	let previous: TerminalEntry | undefined;
	for (const entry of entries) {
		const current = blocks.at(-1);
		if (current && !startsBlock(entry, previous)) {
			current.entries.push(entry);
		} else {
			blocks.push({
				entries: [entry],
				id: entry.id,
				kind:
					entry.kind === "banner" || entry.kind === "command"
						? entry.kind
						: "notice",
			});
		}
		previous = entry;
	}
	return blocks;
}

/**
 * One aligned plain-text row. A cell wider than its column still keeps one
 * space before the next, so copied columns never run together; trailing
 * spaces are trimmed.
 */
export function textRow(
	cells: readonly string[],
	widths: readonly number[]
): string {
	const last = cells.length - 1;
	return cells
		.map((cell, index) =>
			index === last
				? cell
				: cell.padEnd(Math.max(widths[index] ?? 0, cell.length + 1))
		)
		.join("")
		.trimEnd();
}

function threadRowsText(
	rows: readonly TerminalThreadRow[],
	now: number
): string[] {
	const widths = [5, 13, 14, 5];
	return [
		textRow(["#", "status", "agent", "age", "title"], widths),
		...rows.map((row) =>
			textRow(
				[
					String(row.number),
					`${TERMINAL_STATUS_GLYPHS[row.status]} ${TERMINAL_STATUS_WORDS[row.status]}`,
					row.agentLabel,
					compactAge(row.updatedAt, now),
					row.pinned ? `${row.title}  pinned` : row.title,
				],
				widths
			)
		),
	];
}

function entryOutputText(
	entry: TerminalEntry,
	context: { needsYou: readonly TerminalThreadRow[]; now: number }
): string[] {
	switch (entry.kind) {
		case "banner":
			return threadRowsText(context.needsYou, context.now);
		case "command":
			return [];
		case "help":
			return [...TERMINAL_HELP, ...TERMINAL_KEYS].map((row) =>
				textRow([row.usage, row.summary], [26])
			);
		case "threads":
			return threadRowsText(entry.rows, entry.now);
		case "agents":
			return [
				textRow(["agent", "status", "threads", "need you"], [14, 13, 9, 10]),
				...entry.rows.map((row) =>
					textRow(
						[
							row.handle,
							row.status,
							String(row.threadCount),
							String(row.needsYou),
							row.description,
						],
						[14, 13, 9, 10]
					)
				),
			];
		default:
			return [entry.segments.map((segment) => segment.text).join("")];
	}
}

/** A block's output as plain text, for the block's copy action. */
export function terminalBlockText(
	block: TerminalBlock,
	context: { needsYou: readonly TerminalThreadRow[]; now: number }
): string {
	return block.entries
		.flatMap((entry) => entryOutputText(entry, context))
		.join("\n");
}

/** One block of scrollback. */
export function TerminalEntryView({
	agents,
	counts,
	entry,
	loading,
	needsYou,
	now,
	onAction,
}: {
	/** Agents the banner lists. */
	agents: TerminalAgentRow[];
	counts: TerminalCounts;
	entry: TerminalEntry;
	loading: boolean;
	/** Threads the banner lists (see `threadsNeedingYou`). */
	needsYou: TerminalThreadRow[];
	/** Clock for the banner's ages. */
	now: number;
	onAction: RunAction;
}) {
	switch (entry.kind) {
		case "banner":
			return (
				<Banner
					agents={agents}
					counts={counts}
					loading={loading}
					needsYou={needsYou}
					now={now}
					onAction={onAction}
				/>
			);
		case "command":
			return (
				<p className="whitespace-pre-wrap break-words">
					<span className="text-muted-foreground">you@ryu </span>
					<span className="text-foreground">{entry.prompt}</span>
					<span className="text-primary"> ❯ </span>
					<span className="font-medium text-foreground">{entry.text}</span>
				</p>
			);
		case "help":
			return <HelpTable />;
		case "threads":
			return (
				<ThreadTable
					filter={entry.filter}
					now={entry.now}
					onAction={onAction}
					rows={entry.rows}
				/>
			);
		case "agents":
			return <AgentTable onAction={onAction} rows={entry.rows} />;
		default:
			return <Line onAction={onAction} segments={entry.segments} />;
	}
}
