import { describe, expect, test } from "bun:test";
import type { Split, Tab, TabGroup } from "@/src/contexts/TabsContext.tsx";
import { buildSegments } from "./tab-segments.ts";

function tab(id: string, extra: Partial<Tab> = {}): Tab {
	return { id, path: `/artifact/${id}`, title: id, ...extra };
}

const split = { id: "workbench:center" } as Split;
const group = { id: "grp-1" } as TabGroup;

function describeSegments(segments: ReturnType<typeof buildSegments>) {
	return segments.map((segment) => {
		if (segment.type === "tab") {
			return segment.tab.id;
		}
		const id = segment.type === "group" ? segment.group.id : segment.split.id;
		return `${id}[${segment.members.map((member) => member.id).join(",")}]`;
	});
}

describe("buildSegments", () => {
	test("emits one split bracket at its first member when tabs interleave it", () => {
		// The Workbench projection lists the Center split group by group, so the
		// second pane can follow tabs that are not in the split.
		const segments = buildSegments(
			[
				tab("a"),
				tab("b", { splitId: split.id }),
				tab("c"),
				tab("d", { splitId: split.id }),
			],
			[],
			[split]
		);
		expect(describeSegments(segments)).toEqual([
			"a",
			"workbench:center[b,d]",
			"c",
		]);
	});

	test("keeps one bracket per group and renders orphaned members as tabs", () => {
		const segments = buildSegments(
			[
				tab("a", { groupId: group.id }),
				tab("b"),
				tab("c", { groupId: group.id }),
				tab("d", { groupId: "grp-gone", splitId: split.id }),
				tab("e", { splitId: "split-gone" }),
			],
			[group],
			[split]
		);
		expect(describeSegments(segments)).toEqual(["grp-1[a,c]", "b", "d", "e"]);
	});
});
