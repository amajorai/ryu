import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createBrowserStore, searchBrowserDocuments } from "./data.ts";

interface FixtureOpenRequest<Database> {
	onsuccess?: () => void;
	onupgradeneeded?: () => void;
	result: Database;
}

interface FixtureTransaction {
	objectStore(): {
		delete(key: string): { result: undefined };
		get(key: string): { result: unknown };
		getAllKeys(): { result: string[] };
		put<Value>(value: Value, key: string): { result: string };
	};
	oncomplete?: () => void;
}

async function withFixtureDatabase(
	run: (records: Map<string, unknown>) => Promise<void>
) {
	const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
	const records = new Map<string, unknown>();
	const database = {
		close() {},
		createObjectStore() {},
		transaction(): FixtureTransaction {
			const transaction: FixtureTransaction = {
				objectStore: () => ({
					delete: (key) => {
						records.delete(key);
						return { result: undefined };
					},
					get: (key) => ({ result: structuredClone(records.get(key)) }),
					getAllKeys: () => ({ result: [...records.keys()] }),
					put: (value, key) => {
						records.set(key, structuredClone(value));
						return { result: key };
					},
				}),
			};
			queueMicrotask(() => transaction.oncomplete?.());
			return transaction;
		},
	};
	Object.defineProperty(globalThis, "indexedDB", {
		configurable: true,
		value: {
			open() {
				const request: FixtureOpenRequest<typeof database> = {
					result: database,
				};
				queueMicrotask(() => {
					request.onupgradeneeded?.();
					request.onsuccess?.();
				});
				return request;
			},
		},
	});
	try {
		await run(records);
	} finally {
		if (original) {
			Object.defineProperty(globalThis, "indexedDB", original);
		} else {
			Reflect.deleteProperty(globalThis, "indexedDB");
		}
	}
}

describe("browser record boundaries", () => {
	test("round-trips JSON records, keys, missing records and deletion", async () => {
		await withFixtureDatabase(async () => {
			const store = createBrowserStore("json");
			expect(await store.get("missing")).toBeUndefined();
			await store.set("entry", { title: "A", tags: ["local"], count: 2 });
			expect(await store.get("entry")).toEqual({
				title: "A",
				tags: ["local"],
				count: 2,
			});
			expect(await store.keys()).toEqual(["entry"]);
			await store.delete("entry");
			expect(await store.get("entry")).toBeUndefined();
		});
	});

	test("decodes stored data before a typed reader sees it", async () => {
		await withFixtureDatabase(async (records) => {
			const store = createBrowserStore(
				"notes",
				z.object({ title: z.string() })
			);
			await store.set("valid", { title: "Note" });
			expect(await store.get("valid")).toEqual({ title: "Note" });
			records.set("invalid", { title: 42 });
			await expect(store.get("invalid")).rejects.toThrow();
		});
	});

	test("supports schema-owned structured records such as dates", async () => {
		await withFixtureDatabase(async () => {
			const store = createBrowserStore(
				"dates",
				z.object({ createdAt: z.date() })
			);
			const createdAt = new Date("2026-10-06T00:00:00Z");
			await store.set("entry", { createdAt });
			expect((await store.get("entry"))?.createdAt).toEqual(createdAt);
		});
	});

	test("rejects invalid namespaces and oversized records before insertion", async () => {
		expect(() => createBrowserStore("../other-origin")).toThrow(
			"Invalid storage namespace"
		);
		await withFixtureDatabase(async (records) => {
			const store = createBrowserStore("bounded");
			await expect(store.set("x".repeat(201), "data")).rejects.toThrow(
				"Local record exceeds limit"
			);
			await expect(store.set("entry", "x".repeat(2_000_001))).rejects.toThrow(
				"Local record exceeds limit"
			);
			expect(records.size).toBe(0);
		});
	});
});

describe("browser document retrieval", () => {
	test("ranks title matches and returns bounded citations from canonical text", () => {
		const hits = searchBrowserDocuments(
			[
				{ id: "body", title: "Other", text: "A refund can be requested." },
				{
					id: "title",
					title: "Refund policy",
					text: "Requests are accepted within 30 days.",
				},
				{ id: "unrelated", title: "Exports", text: "Download a CSV." },
			],
			"REFUND",
			1
		);
		expect(hits).toEqual([
			{
				id: "title",
				title: "Refund policy",
				excerpt: "Requests are accepted within 30 days.",
				score: 2,
			},
		]);
	});
	test("empty queries do not expose every document and ties are deterministic", () => {
		const docs = [
			{ id: "b", title: "你好", text: "世界" },
			{ id: "a", title: "你好", text: "世界" },
		];
		expect(searchBrowserDocuments(docs, " ")).toEqual([]);
		expect(searchBrowserDocuments(docs, "你好").map((hit) => hit.id)).toEqual([
			"a",
			"b",
		]);
	});
});
