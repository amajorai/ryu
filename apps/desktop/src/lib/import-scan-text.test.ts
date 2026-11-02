import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import type { ScanItem } from "@/src/lib/api/import.ts";
import type { NoticeTranslate } from "./cloud-task-notice-text.ts";
import {
	scanItemDetail,
	scanItemTitle,
	scanWarnings,
} from "./import-scan-text.ts";

const PROJECT = "Project '{name}' from {source} ({count} chats)";
const LATEST = "Latest chat: “{title}”.";
const FOLDER = "Becomes a project folder.";
const CRON =
	"Hermes cron jobs are not imported; recreate them as Ryu schedules.";

const german: NoticeTranslate = (source, values) => {
	const catalog: Record<string, string> = {
		[PROJECT]: "Projekt '{name}' aus {source} ({count} Chats)",
		[LATEST]: "Letzter Chat: „{title}“.",
		[FOLDER]: "Wird zu einem Projektordner.",
		[CRON]:
			"Hermes-Cronjobs werden nicht importiert; lege sie als Ryu-Zeitpläne neu an.",
	};
	return formatMessage(catalog[source] ?? source, values, "de");
};

const project: ScanItem = {
	alreadyExists: false,
	detail: "Latest chat: “Plan”. Becomes a project folder.",
	detailI18n: [
		{ message: LATEST, args: { title: "Plan" } },
		{ message: FOLDER, args: {} },
	],
	id: "conversations/conversations.json#g-p-1",
	kind: "conversations",
	title: "Project 'g-p-1' from ChatGPT (3 chats)",
	titleI18n: {
		message: PROJECT,
		args: {
			count: { number: 3, min_fraction: 0, max_fraction: 0 },
			name: "g-p-1",
			source: "ChatGPT",
		},
	},
};

test("renders scan titles and export details in German", () => {
	expect(scanItemTitle(project, german)).toBe(
		"Projekt 'g-p-1' aus ChatGPT (3 Chats)"
	);
	expect(scanItemDetail(project, german)).toBe(
		"Letzter Chat: „Plan“. Wird zu einem Projektordner."
	);
});

test("renders scan warnings in German and keeps verbatim ones", () => {
	expect(
		scanWarnings(
			{
				warningNotices: [
					{ i18n: { message: CRON, args: {} }, message: CRON },
					{ i18n: null, message: "/x/mcp.json: bad json" },
				],
				warnings: [CRON, "/x/mcp.json: bad json"],
			},
			german
		)
	).toEqual([
		"Hermes-Cronjobs werden nicht importiert; lege sie als Ryu-Zeitpläne neu an.",
		"/x/mcp.json: bad json",
	]);
});

test("an older node's scan shows its English text", () => {
	const older: ScanItem = {
		alreadyExists: false,
		detail: "/home/me/.claude/skills/x",
		id: "skill/skills/x",
		kind: "skill",
		title: "Skill 'x'",
	};
	expect(scanItemTitle(older, german)).toBe("Skill 'x'");
	expect(scanItemDetail(older, german)).toBe("/home/me/.claude/skills/x");
	expect(scanWarnings({ warnings: [CRON] }, german)).toEqual([CRON]);
	expect(
		scanItemDetail(
			{ ...project, detailI18n: [{ bogus: true }, { message: FOLDER }] },
			german
		)
	).toBe(project.detail);
});

const formatWith =
	(catalog: Record<string, string>, locale: string): NoticeTranslate =>
	(source, values) =>
		formatMessage(catalog[source] ?? source, values, locale);

test("renders Japanese details with no space between sentences", () => {
	const japanese = formatWith(
		{
			[PROJECT]: "{source} のプロジェクト「{name}」（{count} 件のチャット）",
			[LATEST]: "最新のチャット:「{title}」。",
			[FOLDER]: "プロジェクトフォルダーになります。",
		},
		"ja"
	);
	expect(scanItemTitle(project, japanese)).toBe(
		"ChatGPT のプロジェクト「g-p-1」（3 件のチャット）"
	);
	expect(scanItemDetail(project, japanese)).toBe(
		"最新のチャット:「Plan」。プロジェクトフォルダーになります。"
	);
});

test("renders Arabic titles and warnings with Arabic digits", () => {
	const arabic = formatWith(
		{
			[PROJECT]: "المشروع '{name}' من {source} ({count} محادثات)",
			[CRON]: "لا تُستورد مهام cron في Hermes؛ أنشئها من جديد كجداول في Ryu.",
		},
		"ar"
	);
	expect(scanItemTitle(project, arabic)).toBe(
		`المشروع 'g-p-1' من ChatGPT (${new Intl.NumberFormat("ar").format(3)} محادثات)`
	);
	expect(
		scanWarnings(
			{
				warningNotices: [{ i18n: { message: CRON, args: {} }, message: CRON }],
				warnings: [CRON],
			},
			arabic
		)
	).toEqual(["لا تُستورد مهام cron في Hermes؛ أنشئها من جديد كجداول في Ryu."]);
});
