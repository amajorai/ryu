import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LiteralMessage } from "@ryu/i18n/react";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
const { presenceLine } = await import("./ChatPage.presence.ts");

const tl: LiteralMessage = (source, values) =>
	`[${source}]${values ? JSON.stringify(values) : ""}`;

describe("presenceLine", () => {
	test("typing names are joined as a list in the reader's language", () => {
		expect(
			presenceLine(
				[
					{ name: "Ada", typing: true },
					{ name: "", typing: true },
				],
				tl
			)
		).toBe(
			'[{count, plural, one {{names} is typing…} other {{names} are typing…}}]{"count":2,"names":"Ada and [Someone]"}'
		);
	});

	test("one person here is named; alone is nothing", () => {
		expect(presenceLine([{ name: "Ada" }], tl)).toBe(
			'[{name} is here]{"name":"Ada"}'
		);
		expect(presenceLine([], tl)).toBeNull();
	});
});
