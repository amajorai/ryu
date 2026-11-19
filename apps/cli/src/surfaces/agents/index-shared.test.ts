import { describe, expect, test } from "bun:test";
import { tf } from "../../i18n/translate.ts";
import { errText } from "./index-shared.tsx";

describe("errText", () => {
	test("a refused connection reads as the localized unreachable sentence", () => {
		const refused = Object.assign(new Error("Unable to connect"), {
			code: "ConnectionRefused",
		});
		expect(errText(refused)).toBe(tf("Core isn't reachable", {}));
	});

	test("uncatalogued text and non-errors pass through", () => {
		expect(errText(new Error("quota_exceeded (req 7f3a)"))).toBe(
			"quota_exceeded (req 7f3a)"
		);
		expect(errText("plain")).toBe("plain");
	});
});
