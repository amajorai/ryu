import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	resolveAgentHandle,
} from "@ryuhq/protocol/interfaces";

export interface MomentsIntent {
	/** The agent named with `@name`, when it resolved. */
	agent: InterfaceAgent | undefined;
	/** The text to send, without the `@name` token. */
	prompt: string;
}

const MENTION = /(^|\s)@([\w.-]+)/;

/** Characters a `@handle` token cannot hold (see `MENTION`). */
const NOT_HANDLE = /[^\w.-]+/g;

/**
 * The `@handle` text for a picked agent, written so `parseMomentsIntent`
 * reads it back as that agent: the name without characters the mention
 * pattern stops at, or the agent id when the name has none it keeps.
 */
export function momentsMentionHandle(agent: InterfaceAgent): string {
	const fromName = agent.name.replace(NOT_HANDLE, "");
	return /[a-z0-9]/i.test(fromName)
		? fromName
		: agent.id.replace(NOT_HANDLE, "");
}

/** Split an intent line into the `@name` agent it addresses and the prompt. */
export function parseMomentsIntent(
	snapshot: InterfaceSnapshot,
	text: string
): MomentsIntent {
	const match = MENTION.exec(text);
	if (!match) {
		return { agent: undefined, prompt: text.trim() };
	}
	const agent = resolveAgentHandle(snapshot, match[2] ?? "");
	if (!agent) {
		return { agent: undefined, prompt: text.trim() };
	}
	const prompt = `${text.slice(0, match.index)}${match[1] ?? ""}${text.slice(
		match.index + match[0].length
	)}`
		.replace(/\s+/g, " ")
		.trim();
	return { agent, prompt };
}

/**
 * The `@` word the caret sits in, so the intent bar can suggest agents for
 * it. Returns the query (without `@`) and where the token starts.
 */
export function momentsMentionQuery(
	text: string,
	caret: number
): { query: string; start: number } | null {
	const before = text.slice(0, caret);
	const match = /(^|\s)@([\w.-]*)$/.exec(before);
	if (!match) {
		return null;
	}
	return {
		query: match[2] ?? "",
		start: before.length - (match[2]?.length ?? 0) - 1,
	};
}

/** Agents whose name starts with (then contains) the query, at most five. */
export function momentsMentionMatches(
	agents: InterfaceAgent[],
	query: string
): InterfaceAgent[] {
	const needle = query.toLowerCase();
	const starts = agents.filter((agent) =>
		agent.name.toLowerCase().startsWith(needle)
	);
	const contains = agents.filter(
		(agent) =>
			!agent.name.toLowerCase().startsWith(needle) &&
			agent.name.toLowerCase().includes(needle)
	);
	return [...starts, ...contains].slice(0, 5);
}
