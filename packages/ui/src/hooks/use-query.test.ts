import { describe, expect, test } from "bun:test";
import { QueryRequestGate } from "./use-query.ts";

describe("QueryRequestGate", () => {
	test("only the newest overlapping request may commit", () => {
		const gate = new QueryRequestGate();
		const poll = gate.begin();
		const manual = gate.begin();

		expect(gate.isCurrent(manual)).toBe(true);
		expect(gate.isCurrent(poll)).toBe(false);
	});

	test("invalidation rejects work from an unmounted query", () => {
		const gate = new QueryRequestGate();
		const request = gate.begin();

		gate.invalidate();

		expect(gate.isCurrent(request)).toBe(false);
	});
});
