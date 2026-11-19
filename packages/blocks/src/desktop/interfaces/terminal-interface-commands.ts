import { translate as tr } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import type {
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { agentHandle } from "./interface-renderer.ts";
import {
	error,
	line,
	muted,
	type NewEntry,
} from "./terminal-interface-entries.ts";
import { resolveStartTarget } from "./terminal-model.ts";
import type { TerminalSegment } from "./terminal-output.tsx";

type PushEntries = (...blocks: NewEntry[]) => void;

/**
 * Stands in for a placeholder so a translated line can be split around it.
 * Its Latin letters make a right-to-left formatter isolate it, so the split
 * leaves FSI and PDI around the emphasised value.
 */
const SLOT = "\u{E000}slot\u{E000}";

/**
 * One translated sentence as muted segments around its emphasised value, so
 * each locale keeps its own word order and the value keeps its own styling.
 */
function slotted(
	text: string,
	value: TerminalSegment[],
	tone: TerminalSegment["tone"] = "muted"
): TerminalSegment[] {
	const at = text.indexOf(SLOT);
	const before = at < 0 ? text : text.slice(0, at);
	const after = at < 0 ? "" : text.slice(at + SLOT.length);
	return [
		...(before ? [{ text: before, tone }] : []),
		...value,
		...(after ? [{ text: after, tone }] : []),
	];
}

/**
 * One translated sentence as muted segments around several emphasised values,
 * each standing in for its own marker, so a locale may order them freely.
 */
function filledSlots(
	text: string,
	slots: readonly (readonly [string, TerminalSegment[]])[]
): TerminalSegment[] {
	let pieces: (string | TerminalSegment)[] = [text];
	for (const [marker, value] of slots) {
		pieces = pieces.flatMap((piece) => {
			if (typeof piece !== "string") {
				return [piece];
			}
			const at = piece.indexOf(marker);
			return at < 0
				? [piece]
				: [piece.slice(0, at), ...value, piece.slice(at + marker.length)];
		});
	}
	return pieces.flatMap((piece) => {
		if (typeof piece !== "string") {
			return [piece];
		}
		return piece ? [{ text: piece, tone: "muted" as const }] : [];
	});
}

/** Stands in for the status word in the live status notice. */
const STATUS_SLOT = "\u{E000}status\u{E000}";

/** The live notice "{title} is now {status}", title and status emphasised. */
export const statusNoticeSegments = (
	tl: LiteralMessage,
	title: TerminalSegment,
	status: TerminalSegment
): TerminalSegment[] =>
	filledSlots(
		tl("{title} is now {status}", { status: STATUS_SLOT, title: SLOT }),
		[
			[SLOT, [title]],
			[STATUS_SLOT, [status]],
		]
	);

/** The line printed when the open thread is closed. */
export const closedLine = (tl: LiteralMessage, title: string): string =>
	tl("Closed {title}", { title });

/** The line printed when a thread is opened, its title emphasised. */
export const openedLine = (
	tl: LiteralMessage,
	title: string,
	number: number | null
): TerminalSegment[] =>
	slotted(tl("Opened {title}", { title: SLOT }), [
		...(number === null
			? []
			: [{ text: `#${number} `, tone: "muted" as const }]),
		{ text: title },
	]);

/** What starting a thread from the prompt reads and acts through. */
export interface TerminalStartContext {
	port: InterfacePort;
	push: PushEntries;
	snapshot: InterfaceSnapshot;
	tl: LiteralMessage;
}

export const startThread = (
	{ port, push, snapshot, tl }: TerminalStartContext,
	handle: string | null,
	prompt: string
) => {
	const message = prompt.trim();
	if (!message) {
		push(
			error(tl("new: missing message")),
			muted(tl("usage: new [@agent] <message>"))
		);
		return;
	}
	const target = resolveStartTarget(snapshot, handle);
	switch (target.kind) {
		case "unknown":
			push(
				line(
					{
						text: tl("new: no agent, team, or project @{handle}", { handle }),
						tone: "error",
					},
					{ text: " ", tone: "muted" },
					...slotted(
						target.close
							? tl("Did you mean {command}?", { command: SLOT })
							: tl("Try {command}", { command: SLOT }),
						target.suggestions.flatMap((suggestion, index) => [
							...(index > 0 ? [{ text: ", ", tone: "muted" as const }] : []),
							{
								action: {
									kind: "fill" as const,
									value: `${suggestion} ${message}`,
								},
								label: tr("Use {suggestion}", { suggestion }),
								text: suggestion,
								tone: "primary" as const,
							},
						])
					)
				)
			);
			return;
		case "agent":
			port.startThread({ agentId: target.agent.id, prompt: message });
			push(
				line(
					{ text: "→ ", tone: "success" },
					...slotted(tl("started a thread with {handle}", { handle: SLOT }), [
						{ text: agentHandle(target.agent.name), tone: "primary" },
					])
				)
			);
			return;
		case "group":
			port.startThread(
				target.group.kind === "team"
					? { prompt: message, teamId: target.group.id }
					: { projectId: target.group.id, prompt: message }
			);
			push(
				line(
					{ text: "→ ", tone: "success" },
					...slotted(
						tl(
							"started a thread in {kind, select, team {team {name}} other {project {name}}}",
							{ kind: target.group.kind, name: SLOT }
						),
						[{ text: target.group.name, tone: "primary" }]
					)
				)
			);
			return;
		default:
			port.startThread({ prompt: message });
			push(
				line(
					{ text: "→ ", tone: "success" },
					{ text: tl("started a new thread"), tone: "muted" }
				)
			);
	}
};

/** The `ls` filter names, typed as commands, so never translated. */
const LS_FILTERS = "all, working, your-turn, waiting, attention, quiet";

export const explainUnknown = (push: PushEntries, raw: string) => {
	const [verb = ""] = raw.split(/\s+/);
	const lower = verb.toLowerCase();
	if (lower === "ls" || lower === "list") {
		push(
			error(
				tr('ls: unknown filter "{filter}"', {
					filter: raw.slice(verb.length).trim(),
				})
			),
			muted(tr("filters: {filters}", { filters: LS_FILTERS }))
		);
		return;
	}
	if (lower === "open" || lower === "cd") {
		push(
			error(tr("open: which thread?")),
			muted(tr("usage: open <n|id> · ls for numbers"))
		);
		return;
	}
	push(
		error(tr("ryu: command not found: {command}", { command: verb })),
		muted(tr("try {command}", { command: "help" }))
	);
};
