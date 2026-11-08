import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { STAGE_COUNT, STAGES, spokenOf } from "./model.ts";
import { stageName } from "./stage-names.ts";

// A stand-in Japanese catalog: every message comes back in Japanese, so any raw
// stage id left in the spoken sentence is an English fragment a reader would hear.
const JA: Record<string, string> = {
	"Stage {position} of {stageCount}, {stageName}. {does}":
		"ステージ {position}/{stageCount}、{stageName}。{does}",
	"Rate limit": "レート制限",
	Firewall: "ファイアウォール",
	Inspector: "インスペクター",
	"Input guardrails": "入力ガードレール",
	Policy: "ポリシー",
	"Companion data loss prevention": "Companion のデータ損失防止",
	Route: "ルーティング",
	Audit: "監査",
};

const ja: LiteralMessage = (source, values = {}) => {
	const template = JA[source] ?? "説明。";
	return template.replace(/\{(\w+)\}/gu, (_, name: string) =>
		String((values as Record<string, unknown>)[name] ?? `{${name}}`)
	);
};

describe("gateway pipeline stage names", () => {
	test("every stage id has a translated display name", () => {
		for (const stage of STAGES) {
			const name = stageName(stage.id, ja);
			expect(name).not.toBe(stage.id);
			expect(Object.values(JA)).toContain(name);
		}
	});

	test("spokenOf under ja speaks the stage name, never the raw id", () => {
		for (let index = 0; index < STAGE_COUNT; index += 1) {
			const stage = STAGES[index];
			if (!stage) {
				throw new Error("missing stage");
			}
			const spoken = spokenOf(index, ja);
			expect(spoken).toContain(stageName(stage.id, ja));
			expect(spoken).not.toContain(stage.id);
		}
	});
});
