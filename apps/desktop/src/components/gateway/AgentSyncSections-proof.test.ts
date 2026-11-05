import { describe, expect, test } from "bun:test";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";
import type {
	AgentSyncBinding,
	AgentSyncExportResult,
	AgentSyncImportResult,
	AgentSyncStatus,
} from "@/src/lib/api/agent-sync.ts";
import {
	acpPersistenceText,
	capabilityRecordsText,
	exportCountsText,
	exportSafetyText,
	importBindingsText,
	importCountsText,
	resumeProofText,
} from "./AgentSyncSections-proof.ts";

const english: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

/** A ja catalog that only knows the messages it is given: any source it is
    missing fails the test instead of silently rendering English. */
function catalog(entries: Record<string, string>): LiteralMessage {
	return (source, values) => {
		const translated = entries[source];
		if (translated === undefined) {
			throw new Error(`Untranslated message: ${source}`);
		}
		return formatMessage(translated, values, "ja");
	};
}

const exportResult = {
	acpResume: [
		{ conversationId: "c1", mode: "load" },
		{ conversationId: "c2", mode: "resume" },
		{ conversationId: "c3", mode: "replay" },
	],
	agents: 3,
	conflicts: 1,
	conversations: 2,
	messages: 1234,
	projectedFiles: 1,
	skills: 1,
} as unknown as AgentSyncExportResult;

const importResult = {
	conflicts: 0,
	failed: 1,
	imported: 2,
	skipped: 0,
} as unknown as AgentSyncImportResult;

const binding = (capabilities: unknown) =>
	({ capabilities }) as unknown as AgentSyncBinding;

const status = {
	bindings: [binding({ loadSession: true }), binding(null)],
	profiles: [{ id: "p1" }],
} as unknown as AgentSyncStatus;

const resumes = [{ mode: "load" }, { mode: "replay" }] as unknown as Parameters<
	typeof resumeProofText
>[1];

function renderAll(tl: LiteralMessage): string[] {
	return [
		exportCountsText(tl, exportResult),
		acpPersistenceText(tl, exportResult),
		exportSafetyText(tl, exportResult),
		resumeProofText(tl, resumes),
		importBindingsText(tl, status),
		importCountsText(tl, importResult),
		capabilityRecordsText(tl, status),
	];
}

describe("Agent Sync proof values", () => {
	test("render English with one/other plural forms and grouped digits", () => {
		expect(renderAll(english)).toEqual([
			"3 agents · 1 skill · 2 conversations · 1,234 messages",
			"2 ACP loads/resumes · 1 transcript replay",
			"1 conflict · 1 file written",
			"1 load/resume · 1 replay fallback",
			"1 profile · 2 ACP bindings",
			"2 imported · 0 skipped · 1 failed",
			"1 capability record · replay fallback remains available",
		]);
	});

	test("render as whole messages under a ja catalog with no English left", () => {
		const ja = catalog({
			"{agents, plural, one {{agentsText} agent} other {{agentsText} agents}} · {skills, plural, one {{skillsText} skill} other {{skillsText} skills}} · {conversations, plural, one {{conversationsText} conversation} other {{conversationsText} conversations}} · {messages, plural, one {{messagesText} message} other {{messagesText} messages}}":
				"エージェント {agentsText} 件 · スキル {skillsText} 件 · 会話 {conversationsText} 件 · メッセージ {messagesText} 件",
			"{resumed, plural, one {{resumedText} ACP load/resume} other {{resumedText} ACP loads/resumes}} · {replayed, plural, one {{replayedText} transcript replay} other {{replayedText} transcript replays}}":
				"ACP 読み込み/再開 {resumedText} 件 · トランスクリプト再生 {replayedText} 件",
			"{conflicts, plural, one {{conflictsText} conflict} other {{conflictsText} conflicts}} · {files, plural, one {{filesText} file written} other {{filesText} files written}}":
				"競合 {conflictsText} 件 · 書き込んだファイル {filesText} 件",
			"{resumed, plural, one {{resumedText} load/resume} other {{resumedText} loads/resumes}} · {replayed, plural, one {{replayedText} replay fallback} other {{replayedText} replay fallbacks}}":
				"読み込み/再開 {resumedText} 件 · 再生フォールバック {replayedText} 件",
			"{profiles, plural, one {{profilesText} profile} other {{profilesText} profiles}} · {bindings, plural, one {{bindingsText} ACP binding} other {{bindingsText} ACP bindings}}":
				"プロファイル {profilesText} 件 · ACP バインディング {bindingsText} 件",
			"{imported} imported · {skipped} skipped · {failed} failed":
				"インポート {imported} 件 · スキップ {skipped} 件 · 失敗 {failed} 件",
			"{records, plural, one {{recordsText} capability record} other {{recordsText} capability records}} · replay fallback remains available":
				"機能レコード {recordsText} 件 · 再生フォールバックは引き続き利用できます",
		});
		const rendered = renderAll(ja);
		expect(rendered[0]).toBe(
			"エージェント 3 件 · スキル 1 件 · 会話 2 件 · メッセージ 1,234 件"
		);
		for (const value of rendered) {
			expect(value).not.toMatch(
				/agents?|skills?|conversations?|messages?|replay|imported|skipped|failed|profiles?|bindings?|conflicts?|written|capability/
			);
		}
	});
});
