// `--random` usage errors are catalogued sentences: English in the message
// (what --json carries), the CLI language for people.
import { expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { localizedTextOf, renderLocalized } from "./localizedText.ts";
import { parseSecretsArgs } from "./secrets-args.ts";
import { randomGeneratorFrom } from "./secrets-random.ts";

test("--random usage errors are catalogued sentences that render translated", () => {
	const japanese = createCliTranslator("ja", {
		"The --length value must be an integer from {min} to {max}.":
			"--length の値は {min} から {max} までの整数である必要があります。",
		"The --charset value must be alphanumeric, hex, base64url, or symbols.":
			"--charset の値は alphanumeric、hex、base64url、symbols のいずれかである必要があります。",
		"The --length and --charset options need --random.":
			"--length と --charset オプションには --random が必要です。",
	});
	const cases = [
		[
			["--random", "--length", "7"],
			"The --length value must be an integer from 8 to 256.",
			"--length の値は 8 から 256 までの整数である必要があります。",
		],
		[
			["--random", "--charset", "emoji"],
			"The --charset value must be alphanumeric, hex, base64url, or symbols.",
			"--charset の値は alphanumeric、hex、base64url、symbols のいずれかである必要があります。",
		],
		[
			["--length", "32"],
			"The --length and --charset options need --random.",
			"--length と --charset オプションには --random が必要です。",
		],
	] as const;
	for (const [args, english, translated] of cases) {
		let error: unknown = null;
		try {
			randomGeneratorFrom(parseSecretsArgs(["set", "X", ...args]));
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(english);
		const localized = localizedTextOf(error as Error);
		expect(localized && renderLocalized(localized, japanese.tf)).toBe(
			translated
		);
	}
});
