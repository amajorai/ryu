// packages/services/src/notify/iterate.ts
//
// `ryu.notify.events.iterate()`: event history across pages (design §5).
// Notify pages with an opaque cursor: each `GET /v1/events` answer carries
// `nextCursor`, which the next request sends back as `before`. Each page is
// one `listEvents()` call on the wrapped client, so the call's fetch shim
// (retries, timeouts, typed errors) applies to every page. The iterator ends
// on a null `nextCursor`, an empty page, a repeated cursor, or `maxItems`.

import type {
	NotificationEvent,
	NotifyAPI,
	NotifyEventList,
	NotifyEventListOptions,
} from "@ryuhq/client";
import { nextCursorField, type Paginated, paginate } from "../pagination.ts";

/** The most events Notify returns in one page (`MAX_EVENTS` in apps/notify). */
export const NOTIFY_MAX_PAGE_SIZE = 100;

/** `events.iterate()` filters: `listEvents()` filters without the cursor the iterator manages. */
export type NotifyEventIterateQuery = Omit<NotifyEventListOptions, "before"> & {
	/** Stop after this many events. */
	maxItems?: number;
};

/** Every event matching `query`, newest first, across pages. */
export function iterateEvents(
	client: Pick<NotifyAPI, "listEvents">,
	query: NotifyEventIterateQuery = {}
): Paginated<NotificationEvent, NotifyEventList> {
	const { maxItems, ...filters } = query;
	return paginate<NotifyEventList, NotificationEvent>({
		fetchPage: (cursor) =>
			client.listEvents(
				cursor === null ? filters : { ...filters, before: cursor }
			),
		items: (page) => page.events,
		maxItems,
		nextCursor: nextCursorField,
	});
}
