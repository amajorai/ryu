import { translate as tr } from "@ryu/i18n/lite";
import type {
	InterfaceAgent,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { formatNameList } from "./interface-renderer.ts";

/** Journal row text: excerpts, agent names, titles and counts, in the UI language. */

/** The body line a journal row shows: the latest message, attributed. */
export function entryExcerpt(thread: InterfaceThread): string {
	const text = thread.lastMessage?.trim();
	if (!text) {
		return tr("No messages yet.");
	}
	return thread.lastMessageRole === "user" ? tr("You: {text}", { text }) : text;
}

/** "Forge", "Atlas and Echo", "Atlas, Echo and 1 more". */
export function agentNames(agents: InterfaceAgent[]): string {
	const [first, second] = agents;
	if (!first) {
		return tr("No agent");
	}
	if (!second) {
		return first.name;
	}
	if (agents.length === 2) {
		return formatNameList([first.name, second.name]);
	}
	return tr("{first}, {second} and {count} more", {
		count: agents.length - 2,
		first: first.name,
		second: second.name,
	});
}

export function entryTitle(thread: InterfaceThread): string {
	return thread.title.trim() || tr("Untitled entry");
}

/** "3 entries", "1 message", "12 results", as ICU messages. */
export function countLabel(
	count: number,
	noun: "entry" | "message" | "result"
): string {
	switch (noun) {
		case "entry":
			return tr("{count, plural, one {# entry} other {# entries}}", {
				count,
			});
		case "message":
			return tr("{count, plural, one {# message} other {# messages}}", {
				count,
			});
		default:
			return tr("{count, plural, one {# result} other {# results}}", {
				count,
			});
	}
}
