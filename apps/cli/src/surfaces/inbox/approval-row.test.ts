import { expect, test } from "bun:test";
import { officialCliLiteralCatalog } from "@ryu/i18n/official-catalog/cli";
import { createCliTranslator } from "../../i18n/translate.ts";
import { localizeApprovalRecord } from "./approval-row.ts";

const german = createCliTranslator("de", officialCliLiteralCatalog("de"));

test("a pending approval's title renders from its Core message in German", () => {
	const row = localizeApprovalRecord(
		{
			id: "appr_1",
			kind: "tool",
			title: "Tool call: shell",
			summary: "Tool call: shell",
			i18n: {
				title: { message: "Tool call: {tool}", args: { tool: "shell" } },
				summary: [{ message: "Tool call: {tool}", args: { tool: "shell" } }],
			},
		},
		german.tf
	);
	expect(row.title).toBe("Toolaufruf: shell");
	expect(row.summary).toBe("Toolaufruf: shell");
	expect(row.id).toBe("appr_1");
});

test("a row without Core messages keeps its stored English", () => {
	const record = { id: "appr_2", title: "Run deploy", summary: "Deploy" };
	expect(localizeApprovalRecord(record, german.tf)).toBe(record);
});
