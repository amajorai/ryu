import { cn } from "@ryu/ui/lib/utils";
import { INTERFACE_PROTOCOL_VERSION } from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import type {
	TerminalAgentRow,
	TerminalCounts,
	TerminalThreadRow,
} from "./terminal-model.ts";
import {
	ActionText,
	HintLine,
	plural,
	type RunAction,
	type TerminalEntry,
	type TerminalSegment,
	type TerminalTone,
	TONE_CLASS,
} from "./terminal-output-primitives.tsx";
import {
	AgentTable,
	HelpTable,
	ThreadTable,
} from "./terminal-output-tables.tsx";

export {
	STATUS_GLYPH_TONE,
	STATUS_TONE,
	StatusGlyph,
	type TerminalAction,
	type TerminalEntry,
	type TerminalSegment,
	TerminalStatus,
	type TerminalTone,
	TONE_CLASS,
} from "./terminal-output-primitives.tsx";
export { TERMINAL_KEYS } from "./terminal-output-tables.tsx";
export {
	groupTerminalBlocks,
	type TerminalBlock,
	terminalBlockText,
	textRow,
} from "./terminal-output-text.ts";

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
