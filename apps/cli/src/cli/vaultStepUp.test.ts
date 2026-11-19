// `--method` validation is one catalogued sentence: English in the message
// (what --json carries), the CLI language for people.
import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { localizedTextOf, renderLocalized } from "./localizedText.ts";
import { chooseMethod } from "./vaultStepUp.ts";

const japanese = createCliTranslator("ja", {
	"The --method value must be one of {methods}.":
		"--method の値は {methods} のいずれかである必要があります。",
});

describe("chooseMethod", () => {
	test("an unknown --method is a catalogued usage error", () => {
		let error: unknown = null;
		try {
			chooseMethod(["totp"], "sms", undefined);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(
			"The --method value must be one of totp, backup, password, otp."
		);
		const localized = localizedTextOf(error as Error);
		expect(localized && renderLocalized(localized, japanese.tf)).toBe(
			"--method の値は totp, backup, password, otp のいずれかである必要があります。"
		);
	});

	test("an offered --method is chosen", () => {
		expect(chooseMethod(["totp", "otp"], "otp", undefined)).toBe("otp");
	});
});
