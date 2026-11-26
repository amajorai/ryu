import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	allowlistRecord,
	allowlistRows,
	pickAllowlistedFields,
} from "./allowlist-projection.ts";

describe("pickAllowlistedFields", () => {
	test("builds a new object with the listed fields and drops the rest", () => {
		const row = { id: "a", name: "A", secret: "s3cret", later: { deep: true } };
		const picked = pickAllowlistedFields(row, ["id", "name", "missing"]);
		expect(picked).toEqual({ id: "a", name: "A" });
		expect(picked).not.toBe(row);
		expect(Object.keys(picked ?? {})).toEqual(["id", "name"]);
		// The input is left as it was.
		expect(row).toEqual({
			id: "a",
			name: "A",
			secret: "s3cret",
			later: { deep: true },
		});
	});

	test("drops a listed field whose value is undefined", () => {
		expect(
			pickAllowlistedFields({ id: "a", name: undefined }, ["id", "name"])
		).toEqual({ id: "a" });
		expect(
			Object.keys(pickAllowlistedFields({ name: undefined }, ["name"]) ?? {})
		).toEqual([]);
	});

	test("returns undefined for a value that is not a plain record", () => {
		for (const value of [null, undefined, "id", 7, true, ["id"]]) {
			expect(pickAllowlistedFields(value, ["id", "0", "length"])).toBe(
				undefined
			);
		}
	});

	test("an own __proto__ entry neither passes nor changes the prototype", () => {
		const row = JSON.parse('{"id":"a","__proto__":{"admin":true}}');
		const unlisted = pickAllowlistedFields(row, ["id"]);
		expect(Object.keys(unlisted ?? {})).toEqual(["id"]);
		expect(Object.getPrototypeOf(unlisted)).toBe(Object.prototype);
		const listed = pickAllowlistedFields(row, ["id", "__proto__"]);
		expect(Object.getPrototypeOf(listed)).toBe(Object.prototype);
		expect(Reflect.get(listed ?? {}, "admin")).toBe(undefined);
	});
});

describe("allowlistRecord", () => {
	const serverSchema = allowlistRecord(
		z.object({ enabled: z.boolean(), name: z.string() })
	);

	test("returns a new object that holds only the listed fields", () => {
		const row = {
			args: ["--api-key", "sk-test"],
			enabled: true,
			name: "db",
			url: "https://h/x?key=abc",
		};
		const parsed = serverSchema.parse(row);
		expect(parsed).toEqual({ enabled: true, name: "db" });
		expect(parsed).not.toBe(row);
		expect(JSON.stringify(parsed)).not.toContain("sk-test");
		expect(JSON.stringify(parsed)).not.toContain("key=abc");
	});

	test("still validates the listed fields", () => {
		expect(serverSchema.safeParse({ enabled: "yes", name: "db" }).success).toBe(
			false
		);
		expect(serverSchema.safeParse({ name: "db" }).success).toBe(false);
		expect(serverSchema.safeParse("db").success).toBe(false);
		expect(serverSchema.safeParse(null).success).toBe(false);
		expect(
			serverSchema.safeParse([{ enabled: true, name: "db" }]).success
		).toBe(false);
	});

	test("does not judge a field it drops", () => {
		expect(
			serverSchema.parse({ enabled: true, name: "db", url: () => "not json" })
		).toEqual({ enabled: true, name: "db" });
	});

	test("a loose or catchall object still cannot pass an unlisted field", () => {
		const row = { id: "a", later: "added by Core" };
		expect(
			allowlistRecord(z.looseObject({ id: z.string() })).parse(row)
		).toEqual({ id: "a" });
		expect(
			allowlistRecord(z.object({ id: z.string() }).catchall(z.string())).parse(
				row
			)
		).toEqual({ id: "a" });
	});

	test("keeps an optional field only when the row has it", () => {
		const schema = allowlistRecord(
			z.object({ id: z.string(), owner: z.string().nullable().optional() })
		);
		expect(schema.parse({ id: "a", extra: 1 })).toEqual({ id: "a" });
		expect(schema.parse({ id: "a", owner: null })).toEqual({
			id: "a",
			owner: null,
		});
	});

	test("its own result parses again to an equal object", () => {
		const once = serverSchema.parse({ enabled: false, name: "db", x: 1 });
		expect(serverSchema.parse(once)).toEqual(once);
	});
});

describe("allowlistRows and nesting", () => {
	const catalogSchema = allowlistRecord(
		z.object({
			servers: allowlistRows(
				allowlistRecord(
					z.object({
						name: z.string(),
						owner: allowlistRecord(z.object({ id: z.string() })),
					})
				)
			),
		})
	);

	test("projects every row and every nested record into new values", () => {
		const servers = [
			{ command: "npx", name: "one", owner: { id: "app", token: "t0ken" } },
			{ env: { KEY: "v" }, name: "two", owner: { id: "app" } },
		];
		const parsed = catalogSchema.parse({ servers, total: 2 });
		expect(parsed).toEqual({
			servers: [
				{ name: "one", owner: { id: "app" } },
				{ name: "two", owner: { id: "app" } },
			],
		});
		expect(parsed.servers).not.toBe(servers);
		expect(parsed.servers[0]).not.toBe(servers[0]);
	});

	test("refuses a list with one bad row and a value that is not a list", () => {
		expect(
			catalogSchema.safeParse({
				servers: [{ name: "one", owner: { id: "app" } }, { name: 2 }],
			}).success
		).toBe(false);
		expect(catalogSchema.safeParse({ servers: { name: "one" } }).success).toBe(
			false
		);
	});
});
