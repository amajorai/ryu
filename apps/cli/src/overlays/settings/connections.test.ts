import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../../i18n/translate.ts";
import { connectedStateText } from "./connections.tsx";

describe("integration connection state", () => {
	test("the access level is translated inside one sentence", () => {
		const german = createCliTranslator("de", {
			"connected · {accessLevel}": "verbunden · {accessLevel}",
			"Read-only": "Nur Lesen",
		});
		expect(connectedStateText("read_only", german)).toBe(
			"verbunden · Nur Lesen"
		);
	});
});
