import { expect, test } from "bun:test";
import { z } from "zod";
import { wireObject } from "./wire-object.ts";

test("declared optional fields admit native containers without copying their internals", () => {
	const schema = wireObject({ name: z.string().optional() });
	for (const input of [new Date(), new Map(), new Set()]) {
		expect(schema.parse(input)).toEqual({});
	}
});
test("projected getters retain their original native and class receivers", () => {
	const date = new Date("2026-01-01T00:00:00Z");
	Object.defineProperty(date, "name", {
		get() {
			return this.toISOString();
		},
	});
	class Named {
		readonly #name = "private";
		get name() {
			return this.#name;
		}
	}
	const schema = wireObject({ name: z.string() });
	expect(schema.parse(date)).toEqual({ name: "2026-01-01T00:00:00.000Z" });
	expect(schema.parse(new Named())).toEqual({ name: "private" });
});
test("missing and inherited undefined fields retain distinct presence", () => {
	const schema = wireObject({ name: z.string().optional() });
	expect(Object.hasOwn(schema.parse({}), "name")).toBe(false);
	expect(
		Object.hasOwn(schema.parse(Object.create({ name: undefined })), "name")
	).toBe(true);
});
test("closed objects check own keys before projecting declared inherited fields", () => {
	const schema = wireObject({ name: z.string() }, true);
	expect(schema.parse(Object.create({ name: "inherited" }))).toEqual({
		name: "inherited",
	});
	expect(schema.safeParse({ name: "own", extra: true }).success).toBe(false);
	expect(schema.safeParse([]).success).toBe(false);
	expect(schema.safeParse(() => "function").success).toBe(false);
});
