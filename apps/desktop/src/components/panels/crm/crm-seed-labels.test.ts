import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { crmLabel, crmLabelI18n } from "./crm-label.tsx";
import {
	CRM_SEED_LABEL_MESSAGES,
	LOCALIZABLE_SEED_LABELS,
} from "./crm-seed-labels.ts";

const JA: Record<string, string> = {
	"All people": "すべてのメンバー",
	"All people (CRM view)": "すべての人物",
	"All deals": "すべての商談",
	"Close date (deal)": "成約予定日",
	"Deals (CRM records)": "商談",
	"Lost (deal stage)": "失注",
	Prospect: "見通し",
	"Prospect (company status)": "見込み",
	"Task board": "タスクボード",
	"Won (deal stage)": "受注",
};

function stubTl(catalog: Record<string, string>): LiteralMessage {
	return (source, values) => formatMessage(catalog[source] ?? source, values);
}

test("seeded deal stages, objects, fields and views take their CRM sense", () => {
	const tl = stubTl(JA);
	expect(crmLabel("Won", tl)).toBe("受注");
	expect(crmLabel("Lost", tl)).toBe("失注");
	expect(crmLabel("Deals", tl)).toBe("商談");
	expect(crmLabel("Close date", tl)).toBe("成約予定日");
	expect(crmLabel("Prospect", tl)).toBe("見込み");
	expect(crmLabel("All deals", tl)).toBe("すべての商談");
	expect(crmLabel("Task board", tl)).toBe("タスクボード");
	// The CRM view, not the workspace-members sense of "All people".
	expect(crmLabel("All people", tl)).toBe("すべての人物");
});

test("English keeps each seed label exactly as the backend seeds it", () => {
	const tl = stubTl({});
	for (const label of Object.keys(CRM_SEED_LABEL_MESSAGES)) {
		expect(crmLabel(label, tl)).toBe(label);
	}
});

test("translated seed labels are closed to the DOM localizer", () => {
	for (const label of Object.keys(CRM_SEED_LABEL_MESSAGES)) {
		expect(LOCALIZABLE_SEED_LABELS.has(label)).toBe(false);
		expect(crmLabelI18n(label)).toBe("off");
	}
	expect(crmLabelI18n("Amount")).toBeUndefined();
	expect(crmLabelI18n("Revenue (typed by a user)")).toBe("off");
});
