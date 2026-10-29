import { expect, test } from "bun:test";
import { parseContinuedOn } from "./continued-on.ts";

test("parses Core's continued_on marker and ignores anything else", () => {
	expect(
		parseContinuedOn({ nodeLabel: "Mac", at: 5, bundleId: "bundle-1" })
	).toEqual({ nodeLabel: "Mac", at: 5 });
	for (const value of [
		undefined,
		null,
		"Mac",
		{ nodeLabel: "", at: 5 },
		{ nodeLabel: "Mac", at: -1 },
		{ nodeLabel: "Mac" },
	]) {
		expect(parseContinuedOn(value)).toBeUndefined();
	}
});
