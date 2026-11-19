// Usage errors that name a flag used to be bare template strings the catalog
// never collected. Each now carries an ICU source with the flags as values, so
// `formatError` renders it in the CLI locale while `.message` stays English.
import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { parseEvalFlags } from "./evalFlags.ts";
import { localizedTextOf, renderLocalized } from "./localizedText.ts";
import { parseSecretsArgs } from "./secrets-args.ts";
import { proposalInput } from "./secrets-broker-agent.ts";
import { parseItemField } from "./secrets-items.ts";
import { parseLeaseSpec } from "./secrets-run-env.ts";

function caught(run: () => unknown): Error {
	try {
		run();
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected a throw");
}

const german = createCliTranslator("de", {
	"Use either {first} or {second}, not both":
		"Verwenden Sie entweder {first} oder {second}, nicht beides",
});

describe("flag usage errors", () => {
	test("keep English and render in the locale", () => {
		const error = caught(() =>
			parseEvalFlags(["--json", "--junit", "out.xml"])
		);
		expect(error.message).toBe("Use either --json or --junit, not both");
		const localized = localizedTextOf(error);
		expect(localized && renderLocalized(localized, german.tf)).toBe(
			"Verwenden Sie entweder --json oder --junit, nicht beides"
		);
	});

	test("each carries an ICU source with the flag as a value", () => {
		const sources = [
			caught(() => parseLeaseSpec("=X")),
			caught(() => parseItemField("novalue")),
			caught(() => parseSecretsArgs(["items", "put", "card", "--cvc", "1"])),
			caught(() =>
				proposalInput(
					parseSecretsArgs([
						"broker",
						"propose",
						"--message",
						"why",
						"--credential",
						"hunter2",
					])
				)
			),
		].map((error) => localizedTextOf(error)?.source);
		expect(sources).toEqual([
			"{flag} needs a dynamic role: {usage}",
			"Invalid {flag} '{spec}'. Use {usage}.",
			"{flag} is not accepted: arguments are visible to other processes and shell history. Pipe the card number and CVC on stdin.",
			"{flag} takes a reference such as {secretReference} or {managerReference}, not '{reference}'. Never pass a value.",
		]);
	});
});
