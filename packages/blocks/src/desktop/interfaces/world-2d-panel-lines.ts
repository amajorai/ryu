import type {
	InterfaceAgent,
	InterfaceAgentAct,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { threadStatus } from "@ryuhq/protocol/interfaces";
import { createContext } from "react";
import type { VillagerStatus } from "./world-2d-model.ts";

/**
 * The act layer is on (a snapshot with `asks`): conversation rows show no
 * legacy status mark or `updatedAt` age.
 */
export const World2dActed = createContext(false);

/**
 * With the act layer, what each villager says (by agent): its act in its
 * own voice, a stopped run's reason included. Agents with nothing to say
 * about an act are left out and greet you as before.
 */
export const World2dActLines = createContext<ReadonlyMap<
	string,
	string
> | null>(null);

/** A villager's line from its act, or null when it has nothing to report. */
export function world2dActLine(
	act: InterfaceAgentAct,
	threads: readonly InterfaceThread[],
	privacy: "full" | "redacted"
): string | null {
	switch (act.act) {
		case "working":
			return privacy === "full" && act.bubble?.text
				? `Hang on: ${act.bubble.text}.`
				: "Hang on, I'm in the middle of something.";
		case "delivering": {
			const thread = threads.find((item) => item.id === act.threadId);
			const summary = privacy === "full" ? thread?.outcome?.summary : null;
			return summary ?? "I have an answer for you.";
		}
		case "asking":
			return "I need you to decide something.";
		case "blocked": {
			const failed = act.blockers.find(
				(blocker) => blocker.kind !== "interrupted"
			);
			return failed
				? `My run stopped: ${failed.title}. Can you take a look?`
				: "My run was interrupted.";
		}
		case "limited": {
			// From the act's own words ("Limit hit, back 15:10", "Likely
			// limit"): the time when it is known, "likely" for an estimate.
			const text = act.bubble?.text ?? "";
			const back = /back (.+)$/.exec(text)?.[1];
			const head = text.startsWith("Likely")
				? "I think I've hit my limit."
				: "I've hit my limit for now.";
			return back ? `${head} I'll be back ${back}.` : head;
		}
		default:
			return null;
	}
}

const GREETINGS = [
	"What do you need?",
	"What are we working on today?",
	"Got something for me?",
	"Good to see you. What's up?",
] as const;

/** What the villager says about one conversation (the open thread). */
function threadLine(thread: InterfaceThread): string {
	const title = thread.title || "our last conversation";
	switch (threadStatus(thread)) {
		case "attention":
			return `I hit a snag on “${title}”. Take a look when you get a chance.`;
		case "your-turn":
			return `I finished up “${title}”. Tell me what's next.`;
		case "working":
			return `Hang on, I'm deep in “${title}”.`;
		case "waiting":
			return `Picking up where we left off on “${title}”.`;
		default:
			return `Here's where we left “${title}”.`;
	}
}

/**
 * What the villager says: about the open conversation when there is one,
 * otherwise a line in their own voice about where they stand with you.
 */
export function villagerLine(
	agent: InterfaceAgent,
	threads: readonly InterfaceThread[],
	status: VillagerStatus,
	brief: boolean,
	openThread: InterfaceThread | null = null
): string {
	if (openThread) {
		return threadLine(openThread);
	}
	if (status === "attention") {
		const stuck = threads.find(
			(thread) => threadStatus(thread) === "attention"
		);
		const line = stuck?.title
			? `I hit a snag on “${stuck.title}”.`
			: "I hit a snag on my last job.";
		return brief ? line : `${line} Take a look when you get a chance.`;
	}
	if (status === "your-turn") {
		const done = threads.find((thread) => threadStatus(thread) === "your-turn");
		const line = done?.title
			? `I finished up “${done.title}”.`
			: "I have an answer for you.";
		return brief ? line : `${line} Have a look and tell me what's next.`;
	}
	if (agent.status === "working" || status === "working") {
		const busy = threads.find((thread) => thread.running);
		const line = busy?.title
			? `Hang on, I'm deep in “${busy.title}”.`
			: "Hang on, I'm in the middle of something.";
		return brief ? line : `${line} Leave me a note and I'll get to it.`;
	}
	let hash = 0;
	for (const char of agent.id) {
		hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 997;
	}
	const greeting = GREETINGS[hash % GREETINGS.length] ?? GREETINGS[0];
	return threads.length > 0
		? `Hey, it's ${agent.name} again. ${greeting}`
		: `Hi, I'm ${agent.name}. First time stopping by? ${greeting}`;
}
