import { describe, expect, test } from "bun:test";
import { nextCursorField, paginate, timestampCursor } from "./pagination.ts";

interface Page {
	data: { id: string }[];
	nextCursor: string | null;
}

function cursorPages(pages: Record<string, Page>) {
	const requested: (string | null)[] = [];
	const iterable = paginate<Page, { id: string }>({
		fetchPage: (cursor) => {
			requested.push(cursor);
			const page = pages[cursor ?? "first"];
			if (!page) {
				throw new Error(`no page for ${cursor}`);
			}
			return Promise.resolve(page);
		},
		items: (page) => page.data,
		nextCursor: nextCursorField,
	});
	return { iterable, requested };
}

const PAGES: Record<string, Page> = {
	first: { data: [{ id: "a" }, { id: "b" }], nextCursor: "c2" },
	c2: { data: [{ id: "c" }], nextCursor: "c3" },
	c3: { data: [{ id: "d" }], nextCursor: null },
};

describe("paginate", () => {
	test("iterates items across pages following nextCursor", async () => {
		const { iterable, requested } = cursorPages(PAGES);
		const ids: string[] = [];
		for await (const item of iterable) {
			ids.push(item.id);
		}
		expect(ids).toEqual(["a", "b", "c", "d"]);
		expect(requested).toEqual([null, "c2", "c3"]);
	});

	test(".pages() yields raw pages and .collect() honours max", async () => {
		const pages: Page[] = [];
		for await (const page of cursorPages(PAGES).iterable.pages()) {
			pages.push(page);
		}
		expect(pages).toHaveLength(3);
		const { iterable, requested } = cursorPages(PAGES);
		expect((await iterable.collect(3)).map((item) => item.id)).toEqual([
			"a",
			"b",
			"c",
		]);
		expect(requested).toEqual([null, "c2"]);
		expect(await cursorPages(PAGES).iterable.collect(0)).toEqual([]);
	});

	test("maxItems bounds iteration", async () => {
		const items = await paginate<Page, { id: string }>({
			fetchPage: () => Promise.resolve(PAGES.first as Page),
			items: (page) => page.data,
			maxItems: 1,
			nextCursor: () => null,
		}).collect();
		expect(items).toEqual([{ id: "a" }]);
	});

	test("stops on an empty page and on a repeated cursor", async () => {
		const loop = { data: [{ id: "x" }], nextCursor: "same" };
		const repeated = cursorPages({ first: loop, same: loop });
		expect((await repeated.iterable.collect()).length).toBe(2);
		expect(repeated.requested).toEqual([null, "same"]);

		const empty = cursorPages({ first: { data: [], nextCursor: "more" } });
		expect(await empty.iterable.collect()).toEqual([]);
		expect(empty.requested).toEqual([null]);
	});

	test("errors propagate out of the iterator", async () => {
		const { iterable } = cursorPages({
			first: { data: [{ id: "a" }], nextCursor: "missing" },
		});
		await expect(iterable.collect()).rejects.toThrow("no page for missing");
	});
});

describe("timestampCursor", () => {
	interface Message {
		createdAt: string;
		id: string;
	}

	test("pages by the last timestamp, stops on a short page, and dedupes ties by key", async () => {
		const pages: Record<string, Message[]> = {
			first: [
				{ createdAt: "t3", id: "m3" },
				{ createdAt: "t2", id: "m2" },
			],
			t2: [
				{ createdAt: "t2", id: "m2" },
				{ createdAt: "t1", id: "m1" },
			],
			t1: [{ createdAt: "t1", id: "m1" }],
		};
		const requested: (string | null)[] = [];
		const items = await paginate<Message[], Message>({
			fetchPage: (before) => {
				requested.push(before);
				return Promise.resolve(pages[before ?? "first"] ?? []);
			},
			items: (page) => page,
			key: (message) => message.id,
			nextCursor: timestampCursor<Message[], Message>({
				field: "createdAt",
				items: (page) => page,
				pageSize: 2,
			}),
		}).collect();
		expect(items.map((message) => message.id)).toEqual(["m3", "m2", "m1"]);
		expect(requested).toEqual([null, "t2", "t1"]);
	});
});
