// Policy-file refusals are catalogued sentences: English in the message (what
// --json carries), the CLI language for people.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliTranslator } from "../i18n/translate.ts";
import { localizedTextOf, renderLocalized } from "./localizedText.ts";
import { readPolicyFile } from "./secrets-admin.ts";

const SHAPE =
	"Policy file {file} must be a JSON object with a rules array, or a rules array.";
const japanese = createCliTranslator("ja", {
	[SHAPE]:
		"ポリシーファイル {file} は、rules 配列を持つ JSON オブジェクトか rules 配列である必要があります。",
	"Policy file {file} must be JSON: {reason}":
		"ポリシーファイル {file} は JSON である必要があります: {reason}",
});
const dir = await mkdtemp(join(tmpdir(), "ryu-policy-file-"));

afterAll(async () => {
	await rm(dir, { force: true, recursive: true });
});

async function refusal(name: string, body: string): Promise<Error> {
	const file = join(dir, name);
	await writeFile(file, body);
	const error = await readPolicyFile(file).then(
		() => null,
		(caught: unknown) => caught
	);
	if (!(error instanceof Error)) {
		throw new Error("expected the policy file to be refused");
	}
	return error;
}

describe("readPolicyFile", () => {
	test("a wrong shape is one catalogued sentence", async () => {
		const error = await refusal("shape.json", '{"rule": []}');
		const file = join(dir, "shape.json");
		expect(error.message).toBe(
			`Policy file ${file} must be a JSON object with a rules array, or a rules array.`
		);
		const localized = localizedTextOf(error);
		expect(localized && renderLocalized(localized, japanese.tf)).toBe(
			`ポリシーファイル ${file} は、rules 配列を持つ JSON オブジェクトか rules 配列である必要があります。`
		);
	});

	test("invalid JSON keeps English in the message", async () => {
		const error = await refusal("broken.json", "{");
		expect(error.message).toStartWith(
			`Policy file ${join(dir, "broken.json")} must be JSON: `
		);
		const localized = localizedTextOf(error);
		expect(localized && renderLocalized(localized, japanese.tf)).toStartWith(
			`ポリシーファイル ${join(dir, "broken.json")} は JSON である必要があります: `
		);
	});

	test("a bare rules array is accepted", async () => {
		const file = join(dir, "rules.json");
		await writeFile(file, '[{"path": "prod/**", "capabilities": ["read"]}]');
		expect(await readPolicyFile(file)).toEqual({
			rules: [{ path: "prod/**", capabilities: ["read"] }],
		});
	});
});
