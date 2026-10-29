import { describe, expect, test } from "bun:test";
import { shellStreamInputSchema } from "./shell-stream-input.ts";

describe("shell stream arguments", () => {
	test("retains nested optional fields rather than dropping valid command arrays", () => {
		const commands = [
			{ id: "save", title: "Save", group: undefined, keywords: undefined },
		];
		const input = shellStreamInputSchema.parse({ commands });
		expect(input.commands).toEqual(commands);
		expect(input.commands).toHaveLength(1);
		expect(Object.hasOwn(input, "commands")).toBe(true);
	});
	test("keeps non-finite stream metadata while leaving service-owned fields unvalidated", () => {
		const commands = [
			{
				id: "save",
				title: "Save",
				future: {
					value: Number.NaN,
					positive: Number.POSITIVE_INFINITY,
					negative: Number.NEGATIVE_INFINITY,
				},
			},
		];
		expect(shellStreamInputSchema.parse({ commands }).commands).toEqual(
			commands
		);
		expect(
			shellStreamInputSchema.parse({ channels: ["future", 1, undefined] })
				.channels
		).toEqual(["future", 1, undefined]);
	});
	test("preserves loose-object fallback and ignores unsupported property values", () => {
		for (const value of [undefined, null, "invalid", []]) {
			expect(shellStreamInputSchema.parse(value)).toEqual({});
		}
		expect(
			shellStreamInputSchema.parse({ callback: () => null, enabled: true })
		).toEqual({ callback: undefined, enabled: true });
	});
});
