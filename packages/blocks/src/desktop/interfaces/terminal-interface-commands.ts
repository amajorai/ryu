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

type PushEntries = (...blocks: NewEntry[]) => void;

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
					{
						text: target.close ? " did you mean " : " try ",
						tone: "muted",
					},
					...target.suggestions.flatMap((suggestion, index) => [
						...(index > 0 ? [{ text: ", ", tone: "muted" as const }] : []),
						{
							action: {
								kind: "fill" as const,
								value: `${suggestion} ${message}`,
							},
							label: `Use ${suggestion}`,
							text: suggestion,
							tone: "primary" as const,
						},
					]),
					{
						text: target.close && target.suggestions.length > 0 ? "?" : "",
						tone: "muted",
					}
				)
			);
			return;
		case "agent":
			port.startThread({ agentId: target.agent.id, prompt: message });
			push(
				line(
					{ text: "→ ", tone: "success" },
					{ text: "started a thread with ", tone: "muted" },
					{ text: agentHandle(target.agent.name), tone: "primary" }
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
					{
						text: `${tl("started a thread in {kind}", { kind: target.group.kind })} `,
						tone: "muted",
					},
					{ text: target.group.name, tone: "primary" }
				)
			);
			return;
		default:
			port.startThread({ prompt: message });
			push(
				line(
					{ text: "→ ", tone: "success" },
					{ text: "started a new thread", tone: "muted" }
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
