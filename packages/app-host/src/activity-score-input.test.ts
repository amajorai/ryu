import { expect, test } from "bun:test";
import {
	isBoundedActivityJson,
	isBoundedActivityScoreRequest,
} from "./activity-score-input.ts";
import { asActivityScoreArg } from "./rpc.ts";

type SharedGraph<Leaf> = Leaf | { a: SharedGraph<Leaf>; b: SharedGraph<Leaf> };

function graph<Leaf extends string | bigint>(
	leaf: Leaf,
	depth: number
): SharedGraph<Leaf> {
	let value: SharedGraph<Leaf> = leaf;
	for (let index = 0; index < depth; index++) {
		value = { a: value, b: value };
	}
	return value;
}

test("scoring bounds expanded work for shared graphs before validation and serialization", () => {
	const invalid = structuredClone(graph(1n, 18));
	const validButExpanding = structuredClone(graph("done", 13));
	for (const value of [invalid, validButExpanding]) {
		expect(isBoundedActivityJson(value)).toBe(false);
		expect(asActivityScoreArg({ response: value })).toBeNull();
		expect(
			asActivityScoreArg({
				response: "done",
				metadata: value,
				vars: value,
				context: value,
				assertions: [value],
			})
		).toEqual({ response: "done" });
		expect(
			isBoundedActivityScoreRequest({
				response: "done",
				extra: graph("done", 18),
			})
		).toBe(false);
	}
});

test("deep trees, cycles, nonfinite leaves, accessors and escaped size are rejected", () => {
	type NestedFixture = string | NestedFixture[];
	let deep: NestedFixture = "done";
	for (let index = 0; index < 1000; index++) {
		deep = [deep];
	}
	interface CyclicFixture {
		self?: CyclicFixture;
	}
	const cycle: CyclicFixture = {};
	cycle.self = cycle;
	let reads = 0;
	const accessor = Object.defineProperty({}, "data", {
		enumerable: true,
		get() {
			reads++;
			return "done";
		},
	});
	for (const value of [
		deep,
		cycle,
		Number.POSITIVE_INFINITY,
		accessor,
		"\u0000".repeat(200_000),
	]) {
		expect(isBoundedActivityJson(value)).toBe(false);
	}
	expect(reads).toBe(0);
});

test("ordinary shared projections retain identity, proto-named data and optional semantics", () => {
	const shared = { text: "done", nested: [null, true, 1] };
	const response = { a: shared, b: shared };
	const metadata = JSON.parse('{"__proto__":{"source":"trace"}}');
	const input = {
		response,
		metadata,
		vars: { shared },
		context: [shared],
		assertions: [{ value: shared }],
	};
	const parsed = asActivityScoreArg(input);
	expect(parsed?.response).toBe(response);
	expect(parsed?.metadata).toBe(metadata);
	expect(parsed?.assertions).toBe(input.assertions);
	expect(parsed?.context).toBe(input.context);
	expect(Object.hasOwn(parsed?.metadata ?? {}, "__proto__")).toBe(true);
	expect(JSON.stringify(parsed)).toContain("__proto__");
	expect(
		isBoundedActivityScoreRequest({ response, metadata, threshold: undefined })
	).toBe(true);
	expect(isBoundedActivityJson("x".repeat(999_998))).toBe(true);
});
