// packages/services/src/connect/iterate.ts
//
// `ryu.connect.usage.iterate()`: every billing receipt line in a window,
// across pages (design §5). `GET /v1/usage` answers `nextCursor`, which the
// next request sends back as `cursor` with the same window. Each page is one
// `usage()` call over the call's fetch shim, so retries, timeouts and typed
// errors apply to every page. Receipts that can never be read (`unresolved`)
// are listed on the first page only; read them with `usage()` or `.pages()`.

import { nextCursorField, type Paginated, paginate } from "../pagination.ts";
import { requireUsageWindow } from "../transport/request.ts";
import type {
	ConnectClient,
	ConnectUsageLine,
	ConnectUsageQuery,
	ConnectUsageReport,
} from "./client.ts";

/** `usage.iterate()` query: the window and page size; the iterator manages the cursor. */
export type ConnectUsageIterateQuery = Omit<ConnectUsageQuery, "cursor"> & {
	/** Stop after this many lines. */
	maxItems?: number;
};

/** Every usage line in the window, oldest first, across pages (`cursor` → `nextCursor`). */
export function iterateUsage(
	client: Pick<ConnectClient, "usage">,
	query: ConnectUsageIterateQuery
): Paginated<ConnectUsageLine, ConnectUsageReport> {
	const { maxItems, ...window } = requireUsageWindow("connect", query);
	return paginate<ConnectUsageReport, ConnectUsageLine>({
		fetchPage: (cursor) =>
			client.usage(cursor === null ? window : { ...window, cursor }),
		items: (page) => page.lines,
		maxItems,
		nextCursor: nextCursorField,
	});
}
