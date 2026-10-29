import { expect, test } from "bun:test";
import {
	type QuestJudgeResult,
	questJudgeResultSchema,
} from "./quest-judge-records.ts";

test("quest judge preserves verdict and skip replies with sidecar metadata", () => {
	const verdict = {
		confidence: 70,
		met: true,
		reason: "Completed",
		metadata: { evidence: ["window", "session"] },
	};
	const skipped = {
		reason: "Detection off",
		skipped: true,
		future: null,
	} satisfies QuestJudgeResult & { future: null };
	expect(questJudgeResultSchema.parse(verdict)).toBe(verdict);
	expect(questJudgeResultSchema.parse(skipped)).toBe(skipped);
	for (const value of [
		{ met: true, reason: "missing confidence" },
		{ confidence: 70, met: "true", reason: "invalid verdict" },
		{ skipped: false, reason: "invalid skip" },
		{ skipped: true },
		null,
	]) {
		expect(questJudgeResultSchema.safeParse(value).success).toBe(false);
	}
});
