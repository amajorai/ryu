import { translate as tr } from "@ryu/i18n/lite";
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
				? tr("Hang on: {text}.", { text: act.bubble.text })
				: tr("Hang on, I'm in the middle of something.");
		case "delivering": {
			const thread = threads.find((item) => item.id === act.threadId);
			const summary = privacy === "full" ? thread?.outcome?.summary : null;
			return summary ?? tr("I have an answer for you.");
		}
		case "asking":
			return tr("I need you to decide something.");
		case "blocked": {
			const failed = act.blockers.find(
				(blocker) => blocker.kind !== "interrupted"
			);
			return failed
				? tr("My run stopped: {title}. Can you take a look?", {
						title: failed.title,
					})
				: tr("My run was interrupted.");
		}
		case "limited": {
			// From the act's own words ("Limit hit, back 15:10", "Likely
			// limit"): the time when it is known, "likely" for an estimate.
			const text = act.bubble?.text ?? "";
			const back = /back (.+)$/.exec(text)?.[1];
			const likely = text.startsWith("Likely");
			if (back) {
				return likely
					? tr("I think I've hit my limit. I'll be back {time}.", {
							time: back,
						})
					: tr("I've hit my limit for now. I'll be back {time}.", {
							time: back,
						});
			}
			return likely
				? tr("I think I've hit my limit.")
				: tr("I've hit my limit for now.");
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

/** A busy villager's line: the run it is deep in, when it has a title. */
export function busyLine(title: string | undefined, brief: boolean): string {
	if (title) {
		return brief
			? tr("Hang on, I'm deep in “{title}”.", { title })
			: tr(
					"Hang on, I'm deep in “{title}”. Leave me a note and I'll get to it.",
					{
						title,
					}
				);
	}
	return brief
		? tr("Hang on, I'm in the middle of something.")
		: tr(
				"Hang on, I'm in the middle of something. Leave me a note and I'll get to it."
			);
}

/** What the villager says about one conversation (the open thread). */
function threadLine(thread: InterfaceThread): string {
	const title = thread.title || tr("our last conversation");
	switch (threadStatus(thread)) {
		case "attention":
			return tr(
				"I hit a snag on “{title}”. Take a look when you get a chance.",
				{
					title,
				}
			);
		case "your-turn":
			return tr("I finished up “{title}”. Tell me what's next.", { title });
		case "working":
			return tr("Hang on, I'm deep in “{title}”.", { title });
		case "waiting":
			return tr("Picking up where we left off on “{title}”.", { title });
		default:
			return tr("Here's where we left “{title}”.", { title });
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
		if (stuck?.title) {
			return brief
				? tr("I hit a snag on “{title}”.", { title: stuck.title })
				: tr("I hit a snag on “{title}”. Take a look when you get a chance.", {
						title: stuck.title,
					});
		}
		return brief
			? tr("I hit a snag on my last job.")
			: tr("I hit a snag on my last job. Take a look when you get a chance.");
	}
	if (status === "your-turn") {
		const done = threads.find((thread) => threadStatus(thread) === "your-turn");
		if (done?.title) {
			return brief
				? tr("I finished up “{title}”.", { title: done.title })
				: tr("I finished up “{title}”. Have a look and tell me what's next.", {
						title: done.title,
					});
		}
		return brief
			? tr("I have an answer for you.")
			: tr("I have an answer for you. Have a look and tell me what's next.");
	}
	if (agent.status === "working" || status === "working") {
		const busy = threads.find((thread) => thread.running);
		return busyLine(busy?.title, brief);
	}
	let hash = 0;
	for (const char of agent.id) {
		hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 997;
	}
	const greeting = tr(GREETINGS[hash % GREETINGS.length] ?? GREETINGS[0]);
	return threads.length > 0
		? tr("Hey, it's {name} again. {greeting}", { greeting, name: agent.name })
		: tr("Hi, I'm {name}. First time stopping by? {greeting}", {
				greeting,
				name: agent.name,
			});
}
