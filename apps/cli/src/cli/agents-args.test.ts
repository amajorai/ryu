// `ryu-cli agents` argument errors are whole catalogued sentences: English in
// the error message (what --json carries), the CLI language for people.
import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { parseAgentsArgs, USAGE } from "./agents-args.ts";
import { localizedTextOf, renderLocalized } from "./localizedText.ts";

const japanese = createCliTranslator("ja", {
	"Unknown flag {name}. Usage: {usage}":
		"不明なフラグ {name} です。使い方: {usage}",
	"{name} needs a value. Usage: {usage}":
		"{name} には値が必要です。使い方: {usage}",
});

function caught(args: readonly string[]): Error {
	try {
		parseAgentsArgs(args);
	} catch (error) {
		if (error instanceof Error) {
			return error;
		}
	}
	throw new Error("expected a usage error");
}

describe("parseAgentsArgs usage errors", () => {
	test("an unknown option keeps English and renders in Japanese", () => {
		const error = caught(["create", "A", "--mode", "individual"]);
		expect(error.message).toBe(`Unknown flag --mode. Usage: ${USAGE}`);
		const localized = localizedTextOf(error);
		expect(localized && renderLocalized(localized, japanese.tf)).toBe(
			`不明なフラグ --mode です。使い方: ${USAGE}`
		);
	});

	test("a flag without a value renders in Japanese", () => {
		const error = caught(["create", "A", "--identity"]);
		expect(error.message).toBe(`--identity needs a value. Usage: ${USAGE}`);
		const localized = localizedTextOf(error);
		expect(localized && renderLocalized(localized, japanese.tf)).toBe(
			`--identity には値が必要です。使い方: ${USAGE}`
		);
	});
});
