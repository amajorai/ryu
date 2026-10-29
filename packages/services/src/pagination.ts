// packages/services/src/pagination.ts
//
// One async-iterator shape for every paginated list. `paginate()` takes a
// page fetcher and two readers (items, next cursor) and returns an
// AsyncIterable of items that also exposes `.pages()` and `.collect()`.
// Iterators always throw RyuError on failure, also in object mode.

/** Items one at a time, plus page-level and collect helpers. */
export interface Paginated<Item, Page> extends AsyncIterable<Item> {
	/** Up to `max` items (default: the `maxItems` given to {@link paginate}, else all). */
	collect(max?: number): Promise<Item[]>;
	/** Raw pages, in order. */
	pages(): AsyncIterable<Page>;
}

/** How to walk one paginated list. */
export interface PaginateOptions<Page, Item> {
	/** Fetches the page after `cursor`; `null` is the first page. */
	fetchPage(cursor: string | null): Promise<Page>;
	/** The page's items. */
	items(page: Page): readonly Item[];
	/** Deduplicates items by this key (for timestamp paging, where boundaries can repeat). */
	key?(item: Item): string;
	/** Stops after this many items. */
	maxItems?: number;
	/** The cursor for the next page, or null when this was the last page. */
	nextCursor(page: Page, last: Item | undefined): string | null;
}

/**
 * Iterates a cursor-paginated list. Iteration stops when `nextCursor` returns
 * null, when a page is empty, when `maxItems` is reached, or when the server
 * hands back a cursor it already returned (which would otherwise loop forever).
 */
export function paginate<Page, Item>(
	options: PaginateOptions<Page, Item>
): Paginated<Item, Page> {
	async function* pages(): AsyncGenerator<Page> {
		let cursor: string | null = null;
		const seenCursors = new Set<string>();
		while (true) {
			const page = await options.fetchPage(cursor);
			yield page;
			const items = options.items(page);
			if (items.length === 0) {
				return;
			}
			const next = options.nextCursor(page, items.at(-1));
			if (next === null || seenCursors.has(next)) {
				return;
			}
			seenCursors.add(next);
			cursor = next;
		}
	}

	async function* items(max: number | undefined): AsyncGenerator<Item> {
		if (max !== undefined && max <= 0) {
			return;
		}
		const seenKeys = new Set<string>();
		let count = 0;
		for await (const page of pages()) {
			for (const item of options.items(page)) {
				if (options.key) {
					const key = options.key(item);
					if (seenKeys.has(key)) {
						continue;
					}
					seenKeys.add(key);
				}
				yield item;
				count += 1;
				if (max !== undefined && count >= max) {
					return;
				}
			}
		}
	}

	return {
		[Symbol.asyncIterator]: () => items(options.maxItems),
		async collect(max?: number): Promise<Item[]> {
			const collected: Item[] = [];
			for await (const item of items(max ?? options.maxItems)) {
				collected.push(item);
			}
			return collected;
		},
		pages,
	};
}

/** `nextCursor` reader for pages shaped `{ nextCursor: string | null }`. */
export function nextCursorField<Page extends { nextCursor?: string | null }>(
	page: Page
): string | null {
	return page.nextCursor ?? null;
}

/**
 * `nextCursor` reader for timestamp paging (`before = last.<field>`): stops on
 * a short page. Pair it with `key` because items sharing the boundary
 * timestamp can be returned twice, or (when more than a page share it) skipped.
 */
export function timestampCursor<Page, Item>(options: {
	field: keyof Item;
	items(page: Page): readonly Item[];
	pageSize: number;
}): (page: Page, last: Item | undefined) => string | null {
	return (page, last) => {
		if (
			last === undefined ||
			last === null ||
			options.items(page).length < options.pageSize
		) {
			return null;
		}
		const value = last[options.field];
		return typeof value === "string" || typeof value === "number"
			? String(value)
			: null;
	};
}
