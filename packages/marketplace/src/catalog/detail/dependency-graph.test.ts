// Unit tests for the Dependencies tab's graph resolution. The properties that
// matter are the ones a naive walk gets wrong and the UI would then present as
// fact: a diamond counted twice, a cycle recursing forever, and — the honesty
// property — a host with no node to ask never being made to claim install state.

import { describe, expect, test } from "bun:test";
import {
	type DependencyLookup,
	type DependencyRecord,
	formatMinVersion,
	resolveDependencyTree,
	tallyDependencies,
} from "./dependency-graph.tsx";

function lookupFrom(
	records: Record<string, Partial<DependencyRecord>>
): DependencyLookup {
	return (id: string) => {
		const found = records[id];
		if (!found) {
			return null;
		}
		return {
			enabled: found.enabled ?? false,
			installed: found.installed ?? true,
			name: found.name ?? id,
			requires: found.requires ?? [],
		};
	};
}

describe("resolveDependencyTree", () => {
	test("resolves ids to display names and keeps the declared version floor", () => {
		const tree = resolveDependencyTree(
			[{ id: "@ryu/spaces", min_version: "1.2.0" }],
			lookupFrom({ "@ryu/spaces": { enabled: true, name: "Spaces" } }),
			"@ryu/notes"
		);
		expect(tree).toHaveLength(1);
		expect(tree[0]?.name).toBe("Spaces");
		expect(tree[0]?.minVersion).toBe("1.2.0");
		expect(tree[0]?.record?.enabled).toBe(true);
	});

	test("walks transitively through each dependency's own requires", () => {
		const tree = resolveDependencyTree(
			[{ id: "spaces" }],
			lookupFrom({
				retrieval: { name: "Retrieval" },
				spaces: {
					name: "Spaces",
					requires: [{ id: "retrieval", minVersion: null }],
				},
			})
		);
		expect(tree[0]?.children.map((c) => c.name)).toEqual(["Retrieval"]);
	});

	test("expands a shared dependency once and marks the second mention", () => {
		const tree = resolveDependencyTree(
			[{ id: "a" }, { id: "shared" }],
			lookupFrom({
				a: { name: "A", requires: [{ id: "shared", minVersion: null }] },
				shared: { name: "Shared" },
			})
		);
		expect(tree[0]?.children[0]?.repeated).toBe(false);
		expect(tree[1]?.repeated).toBe(true);
		// Counted once, or the "3 plugins" summary would overstate the install.
		expect(tallyDependencies(tree).total).toBe(2);
	});

	test("a cycle terminates instead of recursing", () => {
		const tree = resolveDependencyTree(
			[{ id: "a" }],
			lookupFrom({
				a: { name: "A", requires: [{ id: "b", minVersion: null }] },
				b: { name: "B", requires: [{ id: "a", minVersion: null }] },
			})
		);
		// A → B → A: the loop closes on the second mention of A, which renders as a
		// back-reference and is not expanded again.
		const backReference = tree[0]?.children[0]?.children[0];
		expect(backReference?.id).toBe("a");
		expect(backReference?.repeated).toBe(true);
		expect(backReference?.children).toHaveLength(0);
	});

	test("a plugin naming itself is a repeat, not infinite recursion", () => {
		const tree = resolveDependencyTree(
			[{ id: "self" }],
			lookupFrom({ self: { name: "Self" } }),
			"self"
		);
		expect(tree[0]?.repeated).toBe(true);
	});

	test("without a lookup it falls back to prettified ids and claims nothing", () => {
		const tree = resolveDependencyTree([{ id: "com.ryu.spaces" }], null);
		expect(tree[0]?.name).toBe("Spaces");
		expect(tree[0]?.record).toBeNull();
	});
});

describe("tallyDependencies", () => {
	test("splits the tree by what enabling would actually do", () => {
		const tree = resolveDependencyTree(
			[{ id: "on" }, { id: "off" }, { id: "absent" }],
			lookupFrom({
				off: { installed: true, name: "Off" },
				on: { enabled: true, installed: true, name: "On" },
			})
		);
		expect(tallyDependencies(tree)).toEqual({
			alreadyEnabled: 1,
			toEnable: 1,
			toInstall: 1,
			total: 3,
		});
	});
});

test("formatMinVersion marks only bare versions as a floor", () => {
	expect(formatMinVersion("1.2.0")).toBe("≥ 1.2.0");
	expect(formatMinVersion("1.2")).toBe("≥ 1.2");
	expect(formatMinVersion("^1.2")).toBe("^1.2");
	expect(formatMinVersion(">=1.2, <2")).toBe(">=1.2, <2");
});
