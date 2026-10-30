import { TERMINAL_HELP } from "@ryuhq/protocol/interfaces";
import { compactAge } from "./interface-renderer.ts";
import {
	TERMINAL_STATUS_GLYPHS,
	TERMINAL_STATUS_WORDS,
	type TerminalThreadRow,
} from "./terminal-model.ts";
import type { TerminalEntry } from "./terminal-output-primitives.tsx";
import { TERMINAL_KEYS } from "./terminal-output-tables.tsx";

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
