// apps/desktop/src/lib/chat-pull-request-search.ts
//
// Makes chats findable by the pull requests attached to them: typing `#123`,
// `123`, `pr 123`, or `owner/repo#123` in the sidebar chat search or the global
// command palette matches the chat that tracks that pull request.

import { parsePullRequestUrl } from "@/src/lib/api/pull-requests.ts";
import type { Conversation } from "@/types/chat.ts";

/** Search tokens for a set of pull request URLs; empty when none parse. */
export function pullRequestSearchTerms(urls: Iterable<string>): string {
	const terms = new Set<string>();
	for (const url of urls) {
		const reference = parsePullRequestUrl(url);
		if (!reference) {
			continue;
		}
		const { number, owner, repo } = reference;
		terms.add(`#${number}`);
		terms.add(`pr ${number}`);
		terms.add(`pr#${number}`);
		terms.add(`${repo}#${number}`);
		terms.add(`${owner}/${repo}#${number}`);
	}
	return [...terms].join(" ");
}

/** Every pull request URL known for a chat: explicit links plus the branch
 * pull requests Ryu has already looked up for it. */
export function chatPullRequestUrls(
	conversation: Pick<Conversation, "id" | "linkedPullRequests">,
	branchPullRequests: Readonly<Record<string, readonly string[]>>
): string[] {
	return [
		...new Set([
			...(conversation.linkedPullRequests ?? []),
			...(branchPullRequests[conversation.id] ?? []),
		]),
	];
}

/** The text a chat search matches against: its title plus pull request terms. */
export function conversationSearchText(
	conversation: Pick<Conversation, "id" | "linkedPullRequests" | "title">,
	branchPullRequests: Readonly<Record<string, readonly string[]>>
): string {
	const terms = pullRequestSearchTerms(
		chatPullRequestUrls(conversation, branchPullRequests)
	);
	return terms ? `${conversation.title ?? ""} ${terms}` : conversation.title;
}
