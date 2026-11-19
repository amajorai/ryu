import { expect, test } from "bun:test";
import { ruleBadgeMode } from "./RulesAgentEditPanel.tsx";

const JA: Record<string, string> = {
	Always: "常に",
	Auto: "自動",
	Intelligent: "インテリジェント",
	Manual: "手動",
	Path: "パス",
};
const ja = (source: string) => JA[source] ?? source;

test("every rule apply-mode badge reads through the translator", () => {
	expect(ruleBadgeMode("intelligent", ja)).toBe("インテリジェント");
	expect(ruleBadgeMode("path", ja)).toBe("パス");
	expect(ruleBadgeMode("always", ja)).toBe("常に");
	expect(ruleBadgeMode("manual", ja)).toBe("手動");
	expect(ruleBadgeMode(undefined, ja)).toBe("自動");
});
