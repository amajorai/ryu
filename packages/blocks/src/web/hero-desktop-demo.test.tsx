import { expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n";
import { heroDemoRuns } from "./hero-desktop-demo.tsx";

test("every demo prompt and answer is translated before it becomes a message", () => {
	const marked: LiteralMessage = (source) => `«${source}»`;
	const runs = heroDemoRuns(marked);
	expect(runs).toHaveLength(2);
	for (const run of runs) {
		expect(run.prompt).toMatch(/^«.+»$/u);
		expect(run.answer).toMatch(/^«.+»$/u);
	}
	expect(runs[0]?.prompt).toBe(
		"«Prepare a weekly update from the project folder.»"
	);
});
