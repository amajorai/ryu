import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const signals: AbortSignal[] = [];
const queries: string[] = [];
const cursors: (string | null)[] = [];
let hold = true;

function card(id: string) {
	return { id, kind: "skill", name: id };
}

mock.module("@/src/lib/api/marketplace.ts", () => ({
	fetchCatalogPage: (
		_kind: string,
		query: string,
		options: { cursor?: string | null; signal?: AbortSignal } = {}
	) => {
		queries.push(query);
		cursors.push(options.cursor ?? null);
		if (!hold) {
			return Promise.resolve(
				options.cursor
					? { items: [card("b"), card("c")], nextCursor: null }
					: { items: [card("a"), card("b")], nextCursor: "2" }
			);
		}
		return new Promise<never>((_resolve, reject) => {
			if (options.signal) {
				signals.push(options.signal);
				options.signal.addEventListener(
					"abort",
					() => reject(new Error("aborted")),
					{
						once: true,
					}
				);
			}
		});
	},
	// The hook wraps non-catalog failures in the client's error type; aborted
	// requests here never reach that path, so a bare subclass suffices.
	MarketplaceError: class MarketplaceError extends Error {},
}));

const { useMarketplaceCatalog } = await import("./useMarketplaceCatalog.ts");
let root = createRoot(document.createElement("div"));
let state: ReturnType<typeof useMarketplaceCatalog>;

function Reader() {
	state = useMarketplaceCatalog("skill", "seed");
	return null;
}

afterEach(async () => {
	await act(() => root.unmount());
	root = createRoot(document.createElement("div"));
	signals.length = 0;
	queries.length = 0;
	cursors.length = 0;
	hold = true;
});

test("Marketplace search aborts the previous request when the catalog kind changes", async () => {
	await act(() => root.render(<Reader />));
	expect(signals).toHaveLength(1);
	expect(queries).toEqual(["seed"]);

	await act(() => state.setKind("plugin"));

	expect(signals).toHaveLength(2);
	expect(signals[0]?.aborted).toBe(true);
});

test("Load more appends the next page by cursor and stops on the last page", async () => {
	hold = false;
	await act(() => root.render(<Reader />));
	expect(state.items.map((item) => item.id)).toEqual(["a", "b"]);
	expect(state.hasMore).toBe(true);

	await act(() => state.loadMore());

	expect(cursors).toEqual([null, "2"]);
	// The overlapping row is not repeated.
	expect(state.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
	expect(state.hasMore).toBe(false);

	await act(() => state.loadMore());
	expect(cursors).toEqual([null, "2"]);
});
