import { describe, expect, test } from "bun:test";
import { messageIdForLiteral } from "@ryu/i18n/core";
import {
	createBotTerminologyRenderer,
	rendersEnglishOutput,
} from "./bot-terminology-render.ts";

describe("rendersEnglishOutput", () => {
	test("English locales render English", () => {
		expect(rendersEnglishOutput("en", false)).toBe(true);
		expect(rendersEnglishOutput("en-GB", true)).toBe(true);
	});

	test("official locales are translated, so the swap stays off", () => {
		expect(rendersEnglishOutput("fr", false)).toBe(false);
		expect(rendersEnglishOutput("ja-JP", false)).toBe(false);
		expect(rendersEnglishOutput("ar", false)).toBe(false);
	});

	test("a non-English selected pack is translated output", () => {
		expect(rendersEnglishOutput("nl", true)).toBe(false);
	});

	test("a locale without a catalog or pack shows the English source", () => {
		expect(rendersEnglishOutput("nl", false)).toBe(true);
	});
});

describe("createBotTerminologyRenderer", () => {
	test("swaps agent terms without a pack", () => {
		const render = createBotTerminologyRenderer(null);
		expect(render("Create an agent")).toBe("Create a bot");
	});

	test("resolves the pack copy before the swap", () => {
		const render = createBotTerminologyRenderer({
			[messageIdForLiteral("Spawn helper")]: "Spawn an agent",
		});
		expect(render("  Spawn helper  ")).toBe("  Spawn a bot  ");
		expect(render("Agents")).toBe("Bots");
	});
});
