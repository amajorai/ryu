// `ryu init` spawn failures name the fix as one catalogued sentence: English in
// the message (what --json carries), the CLI language for people.
import { expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { realScaffold } from "./api.ts";
import { localizedTextOf, renderLocalized } from "./localizedText.ts";

test("a broken RYU_CREATE_APP_BIN is reported as one catalogued sentence", async () => {
	const saved = process.env.RYU_CREATE_APP_BIN;
	process.env.RYU_CREATE_APP_BIN = "/nonexistent/ryu-create-app-bin";
	const japanese = createCliTranslator("ja", {
		"could not run '{command}': {error}. {fix}":
			"'{command}' を実行できませんでした: {error}。{fix}",
		"Check that RYU_CREATE_APP_BIN points to a working scaffolder.":
			"RYU_CREATE_APP_BIN が動作するスキャフォルダーを指しているか確認してください。",
	});
	try {
		const error = await realScaffold(["demo"]).then(
			() => null,
			(caught: unknown) => caught
		);
		expect(error).toBeInstanceOf(Error);
		const localized = localizedTextOf(error as Error);
		expect((error as Error).message).toEndWith(
			"Check that RYU_CREATE_APP_BIN points to a working scaffolder."
		);
		expect(localized && renderLocalized(localized, japanese.tf)).toEndWith(
			"RYU_CREATE_APP_BIN が動作するスキャフォルダーを指しているか確認してください。"
		);
	} finally {
		if (saved === undefined) {
			delete process.env.RYU_CREATE_APP_BIN;
		} else {
			process.env.RYU_CREATE_APP_BIN = saved;
		}
	}
});
