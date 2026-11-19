// Vault command output under a German stub catalog: empty-list sentences, the
// item header, field placeholders and yes/no cells used to go to stdout raw.
// The stub stands in for the German pack, pinned before any command loads.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

const german = createCliTranslator("de", {
	"No leases.": "Keine Leases.",
	"No share links.": "Keine Freigabelinks.",
	"{key} ({kind}, version {version}, {status})":
		"{key} ({kind}, Version {version}, {status})",
	"(hidden)": "(verborgen)",
	yes: "ja",
	no: "nein",
	"yes ({count})": "ja ({count})",
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
const { fakeNode, json, runSecrets, TIMESTAMP } = await import(
	"../__tests__/secrets-fixture.ts"
);

describe("vault output under German", () => {
	test("empty lists read as German sentences", async () => {
		const node = fakeNode({
			"GET /api/vault/leases": json({ leases: [] }),
			"GET /api/vault/shares": json({ links: [] }),
		});
		expect((await runSecrets(["lease", "list"], node)).out).toBe(
			"Keine Leases.\n"
		);
		expect((await runSecrets(["share", "list"], node)).out).toBe(
			"Keine Freigabelinks.\n"
		);
	});

	test("an item's header, hidden values and yes/no cells are German", async () => {
		const item = {
			id: "it_1",
			environment: "prod",
			path: "/",
			key: "stripe",
			kind: "api",
			version: 1,
			status: "ready",
			fields: [
				{
					name: "api_key",
					type: "password",
					required: false,
					sensitive: true,
					hasValue: true,
				},
			],
			availableOperations: [],
			createdAt: TIMESTAMP,
			updatedAt: TIMESTAMP,
		};
		const node = fakeNode({ "GET /api/vault/items/stripe": json({ item }) });
		const { out } = await runSecrets(["items", "get", "stripe"], node);
		expect(out).toContain("stripe (api, Version 1, ready)");
		expect(out).toMatch(/api_key\s+password\s+ja\s+\(verborgen\)/u);
	});

	test("a protected environment shows its approvals in German", async () => {
		const node = fakeNode({
			"GET /api/vault/environments": json({
				active: "prod",
				environments: [
					{
						slug: "prod",
						name: "Production",
						protected: true,
						requiredApprovals: 2,
						position: 1,
					},
					{
						slug: "dev",
						name: "Development",
						protected: false,
						requiredApprovals: 0,
						position: 2,
					},
				],
			}),
		});
		const { out } = await runSecrets(["env", "list"], node);
		expect(out).toContain("ja (2)");
		expect(out).toMatch(/dev\s+Development\s+nein/u);
	});
});
