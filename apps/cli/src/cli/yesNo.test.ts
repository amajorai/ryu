import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { yesNo } from "./yesNo.ts";

describe("yes/no cells", () => {
	test("render in the locale", () => {
		const german = createCliTranslator("de", { yes: "ja", no: "nein" });
		expect(yesNo(true, german)).toBe("ja");
		expect(yesNo(false, german)).toBe("nein");
		expect(yesNo(true, createCliTranslator(null, null))).toBe("yes");
	});
});
