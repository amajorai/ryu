import { describe, expect, it } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { SkillRelationNode } from "@/src/lib/skill-relations.ts";
import { formatScope } from "./skill-relations-graph-parts.tsx";

const tl: LiteralMessage = (source) => `[${source}]`;

function agent(overrides: Partial<SkillRelationNode>): SkillRelationNode {
	return { id: "a", kind: "agent", label: "Scout", ...overrides };
}

describe("formatScope", () => {
	it("describes each agent scope with a catalogued sentence", () => {
		expect(formatScope(agent({ scopeUnavailable: true }), tl)).toBe(
			"[Scope unavailable; showing the all-enabled default.]"
		);
		expect(formatScope(agent({ scope: "all-enabled" }), tl)).toBe(
			"[Can use every enabled skill on this node.]"
		);
		expect(formatScope(agent({ scope: "none" }), tl)).toBe(
			"[Explicitly configured with no skills.]"
		);
		expect(formatScope(agent({}), tl)).toBe(
			"[Can use the skills in its allowlist that are enabled on this node.]"
		);
	});

	it("has no scope line for skills and tools", () => {
		expect(formatScope({ id: "s", kind: "skill", label: "x" }, tl)).toBeNull();
	});
});
