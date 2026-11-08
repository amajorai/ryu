import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	CORE_IDENTITY_CONFLICT_HINT,
	CoreIdentityError,
	conflictHintText,
	localizedCoreIdentityHint,
} from "./coreIdentity.ts";

const enCatalog = JSON.parse(
	readFileSync(
		new URL("../../../../packages/i18n/locales/en.json", import.meta.url),
		"utf8"
	)
) as string[];

describe("CLI core identity text", () => {
	test("the extractor-visible hint literal matches core-client's hint", () => {
		expect(conflictHintText()).toBe(CORE_IDENTITY_CONFLICT_HINT);
		expect(localizedCoreIdentityHint(CORE_IDENTITY_CONFLICT_HINT)).toBe(
			CORE_IDENTITY_CONFLICT_HINT
		);
	});

	test("the English catalog keeps the hint and the error body keys", () => {
		expect(enCatalog).toContain(CORE_IDENTITY_CONFLICT_HINT);
		expect(enCatalog).toContain(
			"The process answering at {url} could not prove it is your Ryu Core, so the CLI did not send it your token. {hint}."
		);
	});

	test("CoreIdentityError renders through the CLI shim", () => {
		const error = new CoreIdentityError("http://127.0.0.1:7980");
		expect(error.message).toBe(
			`The process answering at http://127.0.0.1:7980 could not prove it is your Ryu Core, so the CLI did not send it your token. ${CORE_IDENTITY_CONFLICT_HINT}.`
		);
	});
});
