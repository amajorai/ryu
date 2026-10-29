import { describe, expect, test } from "bun:test";
// The Rust contract's shared cases are the source of truth for both twins.
import cases from "../../../crates/gateway/contracts/fixtures/tool-credential-ladder-cases-v1.json" with {
	type: "json",
};
import {
	decodeLadderInput,
	resolveToolLadder,
	TOOL_LADDER_CONTRACT_VERSION,
} from "./tool-credential-ladder.ts";

describe("tool credential ladder shared cases", () => {
	test("the case file matches this contract version", () => {
		expect(cases.version).toBe(TOOL_LADDER_CONTRACT_VERSION);
		expect(cases.cases.length).toBeGreaterThanOrEqual(15);
	});

	for (const shared of cases.cases) {
		test(shared.name, () => {
			const resolution = resolveToolLadder(decodeLadderInput(shared.input));
			expect(JSON.parse(JSON.stringify(resolution))).toStrictEqual(
				shared.expected
			);
		});
	}

	test("a tenant rung is never metered and every other selected rung is", () => {
		for (const shared of cases.cases) {
			const { outcome } = resolveToolLadder(decodeLadderInput(shared.input));
			if (outcome.type === "selected") {
				const tenant = outcome.rung === "team" || outcome.rung === "org";
				expect(outcome.metered).toBe(!tenant);
			}
		}
	});

	test("decoding refuses a slot outside the grammar and unknown fields", () => {
		const base = cases.cases[0]?.input ?? {};
		expect(() => decodeLadderInput({ ...base, slot: "tool:Exa" })).toThrow();
		expect(() => decodeLadderInput({ ...base, extra: true })).toThrow();
	});
});
