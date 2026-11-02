import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import {
	CLOUD_TASK_PART_TYPE,
	type CloudTaskTranslate,
	cloudTaskEventText,
	localizeCloudTaskParts,
} from "./cloud-task-event-text.ts";

const PUSHED =
	"Pushed branch {branch} ({files} files changed, +{insertions} -{deletions}).";
const KEPT = "The cloud box is still running until it expires or is stopped.";
const COMPLETED = "The task completed.";

/** A stand-in catalog: Japanese wording for three Core sources. */
const japanese: CloudTaskTranslate = (source, values) => {
	const catalog: Record<string, string> = {
		[PUSHED]:
			"ブランチ {branch} をプッシュしました ({files} 個のファイルを変更、+{insertions} -{deletions})。",
		[KEPT]: "クラウドボックスは期限切れになるか停止されるまで実行中です。",
		[COMPLETED]: "タスクが完了しました。",
	};
	return formatMessage(catalog[source] ?? source, values, "ja");
};

const finishPart = {
	data: {
		branch: "ryu/abc",
		files: 2,
		kind: "finish",
		messages: [
			{
				args: {
					branch: "`ryu/abc`",
					deletions: { max_fraction: 0, min_fraction: 0, number: 4 },
					files: { max_fraction: 0, min_fraction: 0, number: 2 },
					insertions: { max_fraction: 0, min_fraction: 0, number: 1200 },
				},
				message: PUSHED,
			},
			{ args: {}, message: KEPT },
		],
		teardown: "kept",
	},
	type: CLOUD_TASK_PART_TYPE,
};

const english =
	"Pushed branch `ryu/abc` (2 files changed, +1,200 -4).\n\nThe cloud box is still running until it expires or is stopped.";

test("renders a finish in Japanese from its message sources", () => {
	expect(cloudTaskEventText(finishPart.data, japanese, "ja")).toBe(
		"ブランチ `ryu/abc` をプッシュしました (2 個のファイルを変更、+1,200 -4)。\n\nクラウドボックスは期限切れになるか停止されるまで実行中です。"
	);
});

test("replaces the stored English text part with the localized body", () => {
	const parts = [{ text: english, type: "text" }, finishPart];
	const localized = localizeCloudTaskParts(parts, japanese, "ja");
	expect(localized).toHaveLength(1);
	// `as unknown`: the localized part is compared by value, not checked
	// against the input part's shape (whose `text` is never null).
	expect(localized[0] as unknown).toEqual({
		text: cloudTaskEventText(finishPart.data, japanese, "ja"),
		type: "text",
	});
});

test("keeps the verbatim lead and the account prefix", () => {
	const data = {
		kind: "planResult",
		messages: [{ message: COMPLETED }],
		prefix: "Codex · work",
	};
	expect(cloudTaskEventText(data, japanese)).toBe(
		"Codex · work: タスクが完了しました。"
	);
	expect(
		cloudTaskEventText({ kind: "run", lead: "Done.", messages: [] }, japanese)
	).toBe("Done.");
});

test("a message without the part, or with a malformed one, keeps its English", () => {
	const plain = [{ text: english, type: "text" }];
	expect(localizeCloudTaskParts(plain, japanese)).toBe(plain);
	const broken = [
		{ text: english, type: "text" },
		{
			data: { messages: [{ args: { x: [1] }, message: PUSHED }] },
			type: CLOUD_TASK_PART_TYPE,
		},
	];
	expect(localizeCloudTaskParts(broken, japanese)).toEqual([
		{ text: english, type: "text" },
	]);
});

test("formats Core's numbers with the reader's separators (German)", () => {
	const german: CloudTaskTranslate = (source, values) =>
		formatMessage(
			source === PUSHED
				? "Branch {branch} gepusht ({files} Dateien geändert, +{insertions} -{deletions})."
				: source,
			values,
			"de"
		);
	expect(
		cloudTaskEventText(
			{ messages: [finishPart.data.messages[0]] },
			german,
			"de"
		)
	).toBe("Branch `ryu/abc` gepusht (2 Dateien geändert, +1.200 -4).");
});

test("keeps the verbatim branch and links inside an Arabic sentence", () => {
	const PR = "Opened pull request #{number}: {url}";
	const arabic: CloudTaskTranslate = (source, values) =>
		formatMessage(
			source === PR ? "تم فتح طلب السحب #{number}: {url}" : source,
			values,
			"ar"
		);
	const data = {
		kind: "finish",
		messages: [
			{
				args: { number: "7", url: "https://github.com/acme/app/pull/7" },
				message: PR,
			},
		],
	};
	expect(cloudTaskEventText(data, arabic, "ar")).toBe(
		"تم فتح طلب السحب #7: https://github.com/acme/app/pull/7"
	);
});
