// The CRM import result counts records an import created or updated (ja 作成,
// 更新). The bare catalog "Created" and "Updated" are date columns (ja
// 作成日時, 更新日).
import { expect, test } from "bun:test";
import { I18nRuntime } from "@ryu/i18n/core";
import { importResultLabels } from "./import-result-labels.ts";

test("Japanese import counts read 作成 and 更新, not date columns", () => {
	const runtime = new I18nRuntime([], { initialPackId: "official/ja" });
	expect(
		importResultLabels((id, fallback) => runtime.translate(id, {}, fallback))
	).toEqual({ created: "作成", updated: "更新" });
});

test("English keeps Created and Updated", () => {
	expect(importResultLabels((_id, fallback) => fallback)).toEqual({
		created: "Created",
		updated: "Updated",
	});
});
