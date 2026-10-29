import { describe, expect, test } from "bun:test";
import { listPage, nextCursorOf } from "../list-output.ts";
import { settledWith } from "../settled.ts";

interface Page {
	readonly items: readonly string[];
	readonly nextCursor: string | null;
}

function context(json: boolean) {
	let stderr = "";
	return {
		ctx: {
			io: {
				env: {},
				stderr: { write: (chunk: string) => (stderr += chunk) },
				stdin: "",
				stdout: { write: () => true },
			},
			json,
		},
		stderr: () => stderr,
	};
}

const SPEC = {
	noun: "things",
	items: (page: Page) => page.items,
	next: (page: Page) =>
		page.nextCursor === null
			? null
			: `More things: --cursor ${page.nextCursor}`,
};

async function collect(value: unknown): Promise<unknown[]> {
	const items: unknown[] = [];
	for await (const item of value as AsyncIterable<unknown>) {
		items.push(item);
	}
	return items;
}

describe("listPage", () => {
	test("--json returns the call itself, so the page prints as { data, meta }", () => {
		const { ctx, stderr } = context(true);
		const call = Promise.resolve<Page>({ items: ["a"], nextCursor: "c1" });
		expect(listPage(ctx as never, call, SPEC)).toBe(call);
		expect(stderr()).toBe("");
	});

	test("human mode streams the items, then names the next page on stderr", async () => {
		const { ctx, stderr } = context(false);
		const value = listPage(
			ctx as never,
			Promise.resolve<Page>({ items: ["a", "b"], nextCursor: "c1" }),
			SPEC
		);
		expect(await collect(value)).toEqual(["a", "b"]);
		expect(stderr()).toBe("More things: --cursor c1\n");
	});

	test("an empty last page says so on stderr and prints nothing", async () => {
		const { ctx, stderr } = context(false);
		const value = listPage(
			ctx as never,
			Promise.resolve<Page>({ items: [], nextCursor: null }),
			SPEC
		);
		expect(await collect(value)).toEqual([]);
		expect(stderr()).toBe("No things.\n");
	});

	test("a settled call is unwrapped to its data", async () => {
		const { ctx } = context(false);
		const value = listPage<Page>(
			ctx as never,
			Promise.resolve(
				settledWith({ items: ["x"], nextCursor: null }, {
					headers: {},
					requestId: null,
					status: 200,
				} as never)
			),
			SPEC
		);
		expect(await collect(value)).toEqual(["x"]);
	});

	test("a failed call rejects the stream, so the CLI prints the error", async () => {
		const { ctx, stderr } = context(false);
		const value = listPage(
			ctx as never,
			Promise.reject(new Error("down")),
			SPEC
		);
		await expect(collect(value)).rejects.toThrow("down");
		expect(stderr()).toBe("");
	});
});

describe("nextCursorOf", () => {
	test("returns a non-empty cursor, else null", () => {
		expect(nextCursorOf({ nextCursor: "c1" })).toBe("c1");
		expect(nextCursorOf({ nextCursor: "" })).toBeNull();
		expect(nextCursorOf({ nextCursor: null })).toBeNull();
		expect(nextCursorOf({})).toBeNull();
	});
});
