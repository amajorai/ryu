// packages/services/src/messaging/iterate.ts
//
// `iterate()` for the Ryu Messaging lists. The message log pages by `cursor`
// in and `nextCursor` out, newest first; the opt-out list pages by AWS's
// `nextToken`. Each page is one `list()` call on the wrapped client, so the
// call's fetch shim (retries, timeouts, typed errors) applies to every page.
// The message log ends on a null cursor, an empty page, a repeated cursor,
// or `maxItems`. The opt-out list keeps following a non-null `nextToken`
// past an empty page: AWS can return a short or empty page with a token, and
// the server drops entries without a number, so an empty page is not the end.

import type {
	MessagingAPI,
	MessagingMessage,
	MessagingMessageListQuery,
	MessagingMessagePage,
	MessagingOptOut,
	MessagingOptOutPage,
} from "@ryuhq/client";
import { nextCursorField, type Paginated, paginate } from "../pagination.ts";

/** `messages.list()` filters, without the cursor the iterator manages. */
export type MessagingMessageIterateQuery = Omit<
	MessagingMessageListQuery,
	"cursor"
> & {
	/** Stop after this many messages. */
	maxItems?: number;
};

/** `optOuts.iterate()` options. */
export interface MessagingOptOutIterateQuery {
	/** Stop after this many entries. */
	maxItems?: number;
}

/** Every message in the log, newest first, across pages. */
export function iterateMessages(
	client: MessagingAPI,
	query: MessagingMessageIterateQuery = {}
): Paginated<MessagingMessage, MessagingMessagePage> {
	const { maxItems, ...filters } = query;
	return paginate<MessagingMessagePage, MessagingMessage>({
		fetchPage: (cursor) =>
			client.messages.list(cursor === null ? filters : { ...filters, cursor }),
		items: (page) => page.messages,
		maxItems,
		nextCursor: nextCursorField,
	});
}

/**
 * The first page at or after `nextToken` that has entries, or the last page
 * when the list ends (a null or repeated token). Empty pages in between are
 * skipped instead of ending the walk.
 */
async function fetchNonEmptyOptOutPage(
	fetchPage: (nextToken: string | null) => Promise<MessagingOptOutPage>,
	start: string | null
): Promise<MessagingOptOutPage> {
	const seen = new Set<string>();
	let token = start;
	while (true) {
		const page = await fetchPage(token);
		const next = page.nextToken ?? null;
		if (page.optOuts.length > 0 || next === null || seen.has(next)) {
			return page;
		}
		if (token !== null) {
			seen.add(token);
		}
		seen.add(next);
		token = next;
	}
}

/** Every number on the organization's opt-out list, across pages. */
export function iterateOptOuts(
	client: MessagingAPI,
	query: MessagingOptOutIterateQuery = {}
): Paginated<MessagingOptOut, MessagingOptOutPage> {
	const fetchPage = (nextToken: string | null) =>
		client.optOuts.list(nextToken === null ? {} : { nextToken });
	return paginate<MessagingOptOutPage, MessagingOptOut>({
		fetchPage: (nextToken) => fetchNonEmptyOptOutPage(fetchPage, nextToken),
		items: (page) => page.optOuts,
		maxItems: query.maxItems,
		nextCursor: (page) => page.nextToken ?? null,
	});
}
