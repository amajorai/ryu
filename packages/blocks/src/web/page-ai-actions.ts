import { buildRyuDeepLink } from "@ryuhq/protocol/deep-link";

/**
 * The "Open in" entries that sit beside "Copy Markdown" on a content page: the
 * docs site and the landing site's help, guide, legal, and blog pages both read
 * this list, so the assistants offered and the prompt they receive stay the same
 * everywhere. Each surface renders the entries with its own menu primitives.
 */
export type PageAiActionId = "ryu" | "scira" | "chatgpt" | "claude" | "cursor";

export interface PageAiAction {
	href: string;
	id: PageAiActionId;
	/**
	 * A web destination opens in a new tab. The Ryu entry is a `ryu://` deep
	 * link handled by the installed app, so a new tab would only be left empty.
	 */
	newTab: boolean;
	title: string;
}

/** The question handed to every assistant: the same wording Fumadocs uses. */
export function pageQuestionPrompt(pageUrl: string): string {
	return `Read ${pageUrl}, I want to ask questions about it.`;
}

/**
 * `ryu://chat/new?prompt=…`: opens a new chat in the Ryu app with the prompt
 * placed in the composer. The app never sends a linked prompt by itself, so the
 * reader reviews it first. The hosted chat takes no prompt from a URL, which is
 * why this entry targets the app.
 */
export function ryuChatHref(prompt: string): string {
	return buildRyuDeepLink({ kind: "chat", prompt });
}

/** Every "Open in" entry for a page, Ryu first. */
export function pageAiActions(pageUrl: string): PageAiAction[] {
	const prompt = pageQuestionPrompt(pageUrl);
	return [
		{
			id: "ryu",
			title: "Open in Ryu",
			href: ryuChatHref(prompt),
			newTab: false,
		},
		{
			id: "scira",
			title: "Open in Scira AI",
			href: `https://scira.ai/?${new URLSearchParams({ q: prompt })}`,
			newTab: true,
		},
		{
			id: "chatgpt",
			title: "Open in ChatGPT",
			href: `https://chatgpt.com/?${new URLSearchParams({ prompt, hints: "search" })}`,
			newTab: true,
		},
		{
			id: "claude",
			title: "Open in Claude",
			href: `https://claude.ai/new?${new URLSearchParams({ q: prompt })}`,
			newTab: true,
		},
		{
			id: "cursor",
			title: "Open in Cursor",
			href: `https://cursor.com/link/prompt?${new URLSearchParams({ text: prompt })}`,
			newTab: true,
		},
	];
}
