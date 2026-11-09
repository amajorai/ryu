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
		push(error("new: missing message"), muted("usage: new [@agent] <message>"));
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

export const explainUnknown = (push: PushEntries, raw: string) => {
	const [verb = ""] = raw.split(/\s+/);
	const lower = verb.toLowerCase();
	if (lower === "ls" || lower === "list") {
		push(
			error(`ls: unknown filter "${raw.slice(verb.length).trim()}"`),
			muted("filters: all, working, your-turn, waiting, attention, quiet")
		);
		return;
	}
	if (lower === "open" || lower === "cd") {
		push(
			error("open: which thread?"),
			muted("usage: open <n|id> · ls for numbers")
		);
		return;
	}
	push(error(`ryu: command not found: ${verb}`), muted("try help"));
};
