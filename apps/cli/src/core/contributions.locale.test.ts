// An unnamed plugin slash-command argument fell back to `Argument 2` in
// English; the fallback is now a catalogued ICU message.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

const german = createCliTranslator("de", {
	"Argument {number}": "Argument Nr. {number}",
});
mock.module("../i18n/translate.ts", () => ({
	CLI_FORMAT_LOCALE: "de",
	CLI_LOCALE: "de",
	CLI_TRANSLATOR: german,
	createCliTranslator,
	tf: german.tf,
	tr: german.tr,
	trMessage: german.trMessage,
	translateProps: german.translateProps,
}));
const { contributedSlashCommandsFromResponse } = await import(
	"./contributions.ts"
);

describe("contributed slash-command arguments", () => {
	test("an unnamed argument's fallback name reads in the locale", () => {
		const [command] = contributedSlashCommandsFromResponse({
			slash_commands: [
				{
					args: [{ name: "environment" }, { options: ["a"] }],
					command: "/deploy",
					description: "Deploy",
					plugin: "@ryu/deploy",
				},
			],
		});
		expect(command?.args.map((argument) => argument.name)).toEqual([
			"environment",
			"Argument Nr. 2",
		]);
	});
});
