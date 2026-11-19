import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { builderPanelTitle } from "./AssistantPanel-builder-title.ts";

const tl: LiteralMessage = (source, values) =>
	`[${source}]${values ? JSON.stringify(values) : ""}`;

describe("builderPanelTitle", () => {
	test("a named target is one catalogued sentence", () => {
		expect(
			builderPanelTitle({ kind: "agent", targetName: " Scout " }, tl)
		).toBe('[Build {name}]{"name":"Scout"}');
	});

	test("each unnamed target has its own whole sentence", () => {
		expect(builderPanelTitle({ kind: "agent", targetName: "" }, tl)).toBe(
			"[Build this agent]"
		);
		expect(builderPanelTitle({ kind: "workflow", targetName: "" }, tl)).toBe(
			"[Build this workflow]"
		);
		expect(builderPanelTitle({ kind: "dashboard", targetName: "" }, tl)).toBe(
			"[Build this]"
		);
	});

	test("an app-defined label is shown as written", () => {
		expect(
			builderPanelTitle(
				{ kind: "dashboard", label: "Design your home", targetName: "x" },
				tl
			)
		).toBe("Design your home");
	});
});
