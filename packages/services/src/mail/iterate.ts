// packages/services/src/mail/iterate.ts
//
// `ryu.mail.messages.iterate(inboxId, query)`: every message in an inbox,
// newest first, across pages. Mail lists have no cursor, so this pages by
// timestamp: each request asks for messages created before the last one seen
// (`before = last.createdAt`), stops on a short page, and drops repeats by id.
//
// Tie caveat: both servers filter `createdAt < before`, so when more messages
// share the boundary timestamp than fit on the page, the ones past the page
// end are skipped. Identical timestamps are rare for one inbox; use a smaller
// `limit` only if you need to narrow that window.

import type { MailAPI, MailMessage } from "@ryuhq/client";
import { type Paginated, paginate, timestampCursor } from "../pagination.ts";

/** Query for {@link iterateMessages}; the filters of `MailAPI.listMessages`, without `before`. */
export interface MailMessageIterateQuery {
	/** Only messages created after this ISO timestamp. */
	after?: string;
	/** Start below this ISO timestamp instead of at the newest message. */
	before?: string;
	direction?: string;
	labels?: string[];
	/** Messages per request, 1-200. Default 50, the servers' own default. */
	limit?: number;
	/** Stop after this many messages in total. */
	maxItems?: number;
	q?: string;
}

/** The servers' default page size. */
export const MAIL_DEFAULT_PAGE_SIZE = 50;
/** The largest page both servers return (they clamp `limit` to 1-200). */
export const MAIL_MAX_PAGE_SIZE = 200;

/** A requested page size, clamped to what the servers accept. */
export function mailPageSize(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) {
		return MAIL_DEFAULT_PAGE_SIZE;
	}
	return Math.min(MAIL_MAX_PAGE_SIZE, Math.max(1, Math.trunc(limit)));
}

/** Iterates every message in `inboxId`, newest first, with timestamp paging and id dedupe. */
export function iterateMessages(
	api: Pick<MailAPI, "listMessages">,
	inboxId: string,
	query: MailMessageIterateQuery = {}
): Paginated<MailMessage, MailMessage[]> {
	const { maxItems, limit, before, ...filters } = query;
	const pageSize = mailPageSize(limit);
	const items = (page: MailMessage[]) => page;
	return paginate<MailMessage[], MailMessage>({
		fetchPage: (cursor) => {
			const start = cursor ?? before;
			return api.listMessages(inboxId, {
				...filters,
				...(start === undefined ? {} : { before: start }),
				limit: pageSize,
			});
		},
		items,
		key: (message) => message.id,
		...(maxItems === undefined ? {} : { maxItems }),
		nextCursor: timestampCursor<MailMessage[], MailMessage>({
			field: "createdAt",
			items,
			pageSize,
		}),
	});
}
