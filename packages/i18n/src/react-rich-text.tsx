"use client";

import { Fragment, type ReactNode } from "react";
import type { MessageValuesInput } from "./format.ts";
import { useLiteralMessages } from "./react-text.tsx";

/** Renderers for the markup tags a rich message uses, e.g. `{ b: (c) => <strong>{c}</strong> }`. */
export type RichTags = Readonly<
	Record<string, (children: ReactNode) => ReactNode>
>;

export type RichLiteralMessage = (
	source: string,
	values?: MessageValuesInput,
	tags?: RichTags
) => ReactNode;

// Values are data: a "<" inside one must never open a tag. It is swapped for
// a private-use character while the message is parsed, then restored.
const ESCAPED_LT = "";
const TAG = /<([A-Za-z][\w-]*)>([\s\S]*?)<\/\1>/u;

function escapeValues(values: MessageValuesInput): MessageValuesInput {
	if (values === null || typeof values !== "object") {
		return values;
	}
	const escaped: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(values)) {
		escaped[name] =
			typeof value === "string" ? value.replaceAll("<", ESCAPED_LT) : value;
	}
	return escaped;
}

function restore(text: string): string {
	return text.replaceAll(ESCAPED_LT, "<");
}

/** Split `message` into text and tag elements; tags without a renderer stay as text. */
export function renderRichMessage(
	message: string,
	tags: RichTags
): ReactNode[] {
	const nodes: ReactNode[] = [];
	let rest = message;
	let key = 0;
	while (rest.length > 0) {
		const match = TAG.exec(rest);
		if (!match) {
			nodes.push(restore(rest));
			break;
		}
		const [whole, name = "", inner = ""] = match;
		if (match.index > 0) {
			nodes.push(restore(rest.slice(0, match.index)));
		}
		const render = tags[name];
		const children = renderRichMessage(inner, tags);
		nodes.push(
			<Fragment key={key}>
				{render ? render(children) : restore(whole)}
			</Fragment>
		);
		key += 1;
		rest = rest.slice(match.index + whole.length);
	}
	return nodes;
}

/**
 * `tlRich(source, values, tags)`: `tl()` for sentences that wrap part of the
 * copy in markup, written as tags inside the message so translators can move
 * them: `tlRich("Step <b>{title}</b> was skipped.", { title }, { b: (c) =>
 * <strong>{c}</strong> })`. Values are inserted as text, never as markup.
 */
export function useRichLiteralMessages(): RichLiteralMessage {
	const tl = useLiteralMessages();
	return (source, values = {}, tags = {}) => (
		<>{renderRichMessage(tl(source, escapeValues(values)), tags)}</>
	);
}
