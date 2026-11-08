import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createCliTranslator } from "../i18n/translate.ts";
import { mcpSignInRows } from "./agentAccountCatalog-rows.ts";

const germanCatalog: Record<string, string> = JSON.parse(
	readFileSync(
		new URL("../../../../packages/i18n/locales/de.json", import.meta.url),
		"utf8"
	)
);
const german = createCliTranslator("de", germanCatalog);
const english = createCliTranslator(null, null);

const signIns = {
	servers: [
		{
			connections: [
				{
					account_label: "alice@example.com",
					profile_id: "work",
					status: "connected",
				},
				{ profile_id: "prof_2", status: "expired" },
			],
			server_name: "drive",
		},
	],
};

describe("mcpSignInRows", () => {
	test("German renders the auth profile as one translated message", () => {
		const rows = mcpSignInRows(
			{ id: "@ryu/files", name: "Files" },
			signIns,
			german.tf
		);
		expect(rows.map((row) => row.detail)).toEqual([
			"alice@example.com · Profil work",
			"Profil prof_2",
		]);
	});

	test("English keeps the account, the profile and the ` · ` join", () => {
		const rows = mcpSignInRows(
			{ id: "@ryu/files", name: "Files" },
			signIns,
			english.tf
		);
		expect(rows.map((row) => row.detail)).toEqual([
			"alice@example.com · Profile work",
			"Profile prof_2",
		]);
		expect(rows[0]?.title).toBe("Files · drive");
		expect(rows[1]?.status).toBe("Sign in again");
	});
});
