import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type {
	InterfaceEvent,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import type { ApprovalRequest } from "@/src/lib/api/approvals.ts";
import { approvalToAsk } from "./snapshot.ts";
import { scheduleBlockers, summaryBlocker } from "./snapshot-blockers.ts";
import type { SnapshotTranslate } from "./snapshot-util.ts";

// A Japanese stub catalog: the snapshot localizes the copy it writes before
// clamping, so interfaces never splice an English title into a template.
const JA: Record<string, string> = {
	Approve: "承認",
	Interrupted: "中断",
	Reject: "拒否",
	"Run failed": "実行に失敗",
	"Run {tool}?": "{tool} を実行しますか？",
	"Run {tool}": "{tool} を実行",
	"Wants to run {tool}.": "{tool} の実行を求めています。",
	"{title} failed": "{title} が失敗しました",
};
const ja: SnapshotTranslate = (source, values) =>
	formatMessage(JA[source] ?? source, values);

const index = { sessionParents: new Map(), threadIds: new Set<string>() };

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
	return {
		created_at: "2026-10-01T12:00:00.000Z",
		id: "a-1",
		kind: "tool_call",
		risk_tags: [],
		status: "pending",
		summary: "Wants to run shell.run.",
		title: "Run shell.run",
		...overrides,
	} as ApprovalRequest;
}

test("an approval ask renders Core's messages in the reader's locale", () => {
	const ask = approvalToAsk(
		approval({
			i18n: {
				question: { args: { tool: "shell.run" }, message: "Run {tool}?" },
				summary: [
					{ args: { tool: "shell.run" }, message: "Wants to run {tool}." },
				],
				title: { args: { tool: "shell.run" }, message: "Run {tool}" },
			},
			question: "Run shell.run?",
		}),
		index,
		ja
	);
	expect(ask.text).toBe("shell.run を実行しますか？");
	expect(ask.reason).toBe("shell.run の実行を求めています。");
	expect(ask.choices?.map((choice) => choice.label)).toEqual(["承認", "拒否"]);
});

test("an approval from an older Core keeps its stored English text", () => {
	const ask = approvalToAsk(approval(), index, ja);
	expect(ask.text).toBe("Run shell.run");
	expect(ask.reason).toBe("Wants to run shell.run.");
});

test("a failed routine's blocker title is one translated sentence", () => {
	const failure: InterfaceEvent = {
		agentId: "coder",
		count: null,
		end: "2026-10-01T10:05:00.000Z",
		error: "source down",
		id: "run-1",
		jobId: "job-1",
		kind: "past",
		label: null,
		outcome: "failure",
		requiresApproval: false,
		start: "2026-10-01T10:00:00.000Z",
		threadId: "t-1",
		title: "Nightly sync",
	};
	expect(scheduleBlockers([failure], ja).get("t-1")?.title).toBe(
		"Nightly sync が失敗しました"
	);
});

test("run-state blocker titles are written in the reader's locale", () => {
	const thread = { id: "t-1", runState: "failed" } as InterfaceThread;
	expect(summaryBlocker(thread, undefined, ja)?.title).toBe("実行に失敗");
	expect(
		summaryBlocker({ ...thread, runState: "interrupted" }, undefined, ja)?.title
	).toBe("中断");
	expect(summaryBlocker(thread, undefined)?.title).toBe("Run failed");
});
