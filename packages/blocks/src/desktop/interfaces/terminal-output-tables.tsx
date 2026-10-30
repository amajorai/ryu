import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { TERMINAL_HELP, type ThreadStatus } from "@ryuhq/protocol/interfaces";
import { compactAge } from "./interface-renderer.ts";
import {
	TERMINAL_STATUS_WORDS,
	type TerminalAgentRow,
	type TerminalThreadRow,
} from "./terminal-model.ts";
import {
	ActionText,
	HintLine,
	plural,
	type RunAction,
	StatusGlyph,
	TerminalStatus,
} from "./terminal-output-primitives.tsx";

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

export function HelpTable() {
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

export function ThreadTable({
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
	const tl = useLiteralMessages();
	if (rows.length === 0) {
		return (
			<p className="text-muted-foreground">
				{filter === "all"
					? "no threads yet · new <message> or @agent <message>"
					: tl("no {status} threads · ls to see all", {
							status: TERMINAL_STATUS_WORDS[filter],
						})}
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
							: tl("{status} threads", {
									status: TERMINAL_STATUS_WORDS[filter],
								}))}
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
									label={tl(
										"Open thread {number}: {title}{pinned, select, true { (pinned)} other {}}",
										{
											number: String(row.number),
											pinned: row.pinned ? "true" : "false",
											title: row.title,
										}
									)}
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

export function AgentTable({
	onAction,
	rows,
}: {
	onAction: RunAction;
	rows: TerminalAgentRow[];
}) {
	const tl = useLiteralMessages();
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
									label={tl("Message {name}", { name: row.name })}
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
