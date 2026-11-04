import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import type { AgentSyncScanItem } from "@/src/lib/api/agent-sync.ts";
import {
	agentSyncItemTitle,
	agentSyncWarnings,
	CURSOR_HISTORY_NOTICE,
} from "./agent-sync-scan-text.ts";
import type { NoticeTranslate } from "./cloud-task-notice-text.ts";

const SKILL = "Agent skill '{name}'";
const CRON =
	"Hermes cron jobs are not imported; recreate them as Ryu schedules.";

const japanese: NoticeTranslate = (source, values) => {
	const catalog: Record<string, string> = {
		[SKILL]: "エージェントスキル「{name}」",
		[CURSOR_HISTORY_NOTICE]:
			"Cursor のネイティブ会話履歴は文書化されたインポート形式ではありません。ポータブルバンドルを使用してください。",
		[CRON]:
			"Hermes の cron ジョブはインポートされません。Ryu のスケジュールとして作り直してください。",
	};
	return formatMessage(catalog[source] ?? source, values, "ja");
};

test("renders a forwarded item title message in Japanese", () => {
	const item = {
		id: "skills/review",
		kind: "skill",
		title: "Agent skill 'review'",
		title_i18n: { message: SKILL, args: { name: "review" } },
	} as AgentSyncScanItem;
	expect(agentSyncItemTitle(item, japanese)).toBe(
		"エージェントスキル「review」"
	);
});

test("keeps the English title from a node without title_i18n", () => {
	const item: AgentSyncScanItem = {
		id: "skills/review",
		kind: "skill",
		title: "Agent skill 'review'",
	};
	expect(agentSyncItemTitle(item, japanese)).toBe("Agent skill 'review'");
});

test("renders the Cursor history notice and plain warnings in Japanese", () => {
	const filled = "Skipped /tmp/{x}/big.json because it is too large to scan.";
	expect(
		agentSyncWarnings(
			{ warnings: [CURSOR_HISTORY_NOTICE, CRON, filled, "Agent 'x' failed"] },
			japanese
		)
	).toEqual([
		"Cursor のネイティブ会話履歴は文書化されたインポート形式ではありません。ポータブルバンドルを使用してください。",
		"Hermes の cron ジョブはインポートされません。Ryu のスケジュールとして作り直してください。",
		filled,
		"Agent 'x' failed",
	]);
});

test("prefers forwarded warning notices when a node sends them", () => {
	const scan = {
		warningNotices: [
			{ i18n: { message: SKILL, args: { name: "a" } }, message: "x" },
			{ message: "verbatim" },
		],
		warnings: ["Agent skill 'a'", "/tmp/{weird}"],
	};
	expect(agentSyncWarnings(scan, japanese)).toEqual([
		"エージェントスキル「a」",
		"/tmp/{weird}",
	]);
});

test("leaves English titles and warnings unchanged", () => {
	const english: NoticeTranslate = (source, values) =>
		formatMessage(source, values, "en");
	const item = {
		id: "skills/review",
		kind: "skill",
		title: "Agent skill 'review'",
		title_i18n: { message: SKILL, args: { name: "review" } },
	} as AgentSyncScanItem;
	const warnings = [CURSOR_HISTORY_NOTICE, CRON, "Agent 'x' failed"];
	expect(agentSyncItemTitle(item, english)).toBe(item.title);
	expect(agentSyncWarnings({ warnings }, english)).toEqual(warnings);
});
