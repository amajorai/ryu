import { describe, expect, test } from "bun:test";
import { buildBuilderPreamble } from "./builderPreamble.ts";

describe("app-defined surface preamble", () => {
	const session = {
		kind: "plugin:com.ryu.example",
		preamble: "Help with this page.",
		targetName: "Example",
		tools: [] as string[],
	};

	test("adds the snapshot as current state when there is one", () => {
		expect(buildBuilderPreamble(session, "id-1", "board: 2 widgets")).toBe(
			"Help with this page.\n\nCurrent state:\nboard: 2 widgets"
		);
	});

	test("adds nothing for an empty snapshot so removable context stays the only channel", () => {
		expect(buildBuilderPreamble(session, "id-1", "")).toBe(
			"Help with this page."
		);
		expect(buildBuilderPreamble(session, "id-1", "  ")).toBe(
			"Help with this page."
		);
	});
});
