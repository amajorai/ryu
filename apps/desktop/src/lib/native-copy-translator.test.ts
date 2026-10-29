import { describe, expect, test } from "bun:test";
import { messageIdForLiteral } from "@ryu/i18n/core";
import {
	createNativeCopyTranslator,
	type NativeCopyI18n,
} from "./native-copy-translator.ts";

const KNOWN = "Your agent needs approval";
const KNOWN_ID = messageIdForLiteral(KNOWN);

function fakeI18n(messages: Record<string, string>): NativeCopyI18n {
	return {
		availablePacks: [],
		hasOverlayMessage: (id) => Object.hasOwn(messages, id),
		t: (id, _values, fallback) => messages[id] ?? fallback,
	};
}

describe("createNativeCopyTranslator", () => {
	test("translates a known first-party literal", () => {
		const translate = createNativeCopyTranslator(
			fakeI18n({ [KNOWN_ID]: "Votre agent attend une approbation" }),
			false
		);
		expect(translate(KNOWN)).toBe("Votre agent attend une approbation");
	});

	test("swaps bot terms only on known literals", () => {
		const translate = createNativeCopyTranslator(
			fakeI18n({ [KNOWN_ID]: KNOWN }),
			true
		);
		expect(translate(KNOWN)).toBe("Your bot needs approval");
		expect(translate("Sales Agent")).toBe("Sales Agent");
		expect(translate("the agent replied")).toBe("the agent replied");
	});

	test("without i18n, unknown text is untouched even with bot terms on", () => {
		const translate = createNativeCopyTranslator(null, true);
		expect(translate("Sales Agent")).toBe("Sales Agent");
	});

	test("pack messages count as known literals", () => {
		const translate = createNativeCopyTranslator(
			{
				availablePacks: [{ messages: { [KNOWN_ID]: "Pack copy" } }],
				hasOverlayMessage: () => false,
				t: (_id, _values, fallback) => `T:${fallback}`,
			},
			false
		);
		expect(translate(KNOWN)).toBe(`T:${KNOWN}`);
		expect(translate("Agent Smith")).toBe("Agent Smith");
	});
});
