// packages/services-cli/src/list-output.ts
//
// One stdout convention for every one-page list command (`mail inboxes list`,
// `notify events list`, `box list`, `sites list`, ...):
//
// - human mode prints the page's items, one compact JSON line each (the same
//   lines `--all` streams), and names the next page on stderr, so stdout
//   holds only items whichever way a list is read;
// - `--json` prints `{ data, meta }` with the page exactly as the SDK's
//   object mode returns it (cursor fields included);
// - `--all`, where a list has it, streams every item as NDJSON.
//
// A command returns `listPage(ctx, call, spec)` instead of the call itself.

import type { CommandContext } from "./registry.ts";
import { type SettledCall, settledData } from "./settled.ts";

/** How to read one list page. */
export interface ListPageSpec<Page> {
	/** The page's items. */
	items(page: Page): readonly unknown[];
	/**
	 * The stderr line naming the next page (`More events: pass --before c1
	 * ...`), or null when this is the last page or the list has no paging.
	 */
	next?(page: Page): string | null;
	/** Plural noun for the empty-page note on stderr (`No inboxes.`). */
	readonly noun: string;
}

/** Yields the page's items, then writes the empty or next-page note to stderr. */
async function* pageItems<Page>(
	call: PromiseLike<Page | SettledCall>,
	spec: ListPageSpec<Page>,
	stderr: CommandContext["io"]["stderr"]
): AsyncGenerator<unknown> {
	const page = settledData(await call) as Page;
	const items = spec.items(page);
	yield* items;
	if (items.length === 0) {
		stderr.write(`No ${spec.noun}.\n`);
	}
	const next = spec.next?.(page) ?? null;
	if (next !== null) {
		stderr.write(`${next}\n`);
	}
}

/**
 * The value a one-page list command returns: under `--json` the call itself,
 * so the page and its response meta print as `{ data, meta }`; otherwise the
 * page's items as a stream (one JSON line each) with paging notes on stderr.
 * `call` may also be a {@link settled} call.
 */
export function listPage<Page>(
	ctx: Pick<CommandContext, "io" | "json">,
	call: PromiseLike<Page | SettledCall>,
	spec: ListPageSpec<Page>
): unknown {
	if (ctx.json) {
		return call;
	}
	return pageItems(call, spec, ctx.io.stderr);
}

/** `nextCursor` of a cursor page, or null. */
export function nextCursorOf(page: {
	nextCursor?: string | null;
}): string | null {
	const cursor = page.nextCursor;
	return typeof cursor === "string" && cursor !== "" ? cursor : null;
}
