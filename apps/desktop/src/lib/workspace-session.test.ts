import { describe, expect, test } from "bun:test";
import {
	emptyWorkspaceSessionState,
	parseWorkspaceSessionState,
	sameWorkspaceSessionState,
} from "./workspace-session.ts";

describe("workspace session snapshots", () => {
	test("normalizes a saved dock and clamps its active tab", () => {
		const state = parseWorkspaceSessionState({
			bottom: {
				activeIndex: 99.8,
				tabs: [
					{ kind: "terminal", label: "Terminal", project: true, uid: "p-1" },
					{ kind: "codereview", label: "Changes" },
				],
			},
			bottomOpen: true,
			right: { activeIndex: -4, tabs: [{ kind: "files", label: "Files" }] },
			rightOpen: false,
		});

		expect(state).toEqual({
			bottom: {
				activeIndex: 1,
				tabs: [
					{ kind: "terminal", label: "Terminal", project: true, uid: "p-1" },
					{ kind: "codereview", label: "Changes" },
				],
			},
			bottomOpen: true,
			right: { activeIndex: 0, tabs: [{ kind: "files", label: "Files" }] },
			rightOpen: false,
		});
	});

	test("drops malformed tabs without breaking the rest of the snapshot", () => {
		const state = parseWorkspaceSessionState({
			bottom: {
				activeIndex: 0,
				tabs: [
					null,
					{ kind: "", label: "empty kind" },
					{ kind: "files", label: "Files" },
				],
			},
			bottomOpen: "yes",
			right: null,
			rightOpen: true,
		});

		expect(state?.bottom.tabs).toEqual([{ kind: "files", label: "Files" }]);
		expect(state?.bottomOpen).toBe(false);
		expect(state?.right).toEqual({ activeIndex: 0, tabs: [] });
	});

	test("migrates synthetic subagent tabs into the stable roster tab", () => {
		const state = parseWorkspaceSessionState({
			bottom: { activeIndex: 0, tabs: [] },
			bottomOpen: false,
			right: {
				activeIndex: 0,
				tabs: [{ kind: "subagent", label: "Atlas", uid: "legacy-agent" }],
			},
			rightOpen: true,
		});

		expect(state?.right.tabs).toEqual([
			{ kind: "subagents", label: "Subagents", uid: "legacy-agent" },
		]);
	});

	test("treats missing and empty state as distinct input shapes safely", () => {
		const empty = emptyWorkspaceSessionState();
		expect(parseWorkspaceSessionState(null)).toBeUndefined();
		expect(sameWorkspaceSessionState(empty, emptyWorkspaceSessionState())).toBe(
			true
		);
		expect(sameWorkspaceSessionState(empty, undefined)).toBe(false);
	});

	test("retains historical and future identifiers for renderer boundary normalization", () => {
		const state = parseWorkspaceSessionState({
			bottom: {
				tabs: [
					{ kind: "browser", label: "Legacy browser" },
					{ kind: "future-panel", label: "Future panel" },
					{ kind: "plugin:@ryu/custom:panel", label: "Plugin panel" },
				],
				activeIndex: 2,
			},
		});
		expect(state?.bottom.tabs.map((tab) => tab.kind)).toEqual([
			"browser",
			"future-panel",
			"plugin:@ryu/custom:panel",
		]);
		expect(state?.bottom.activeIndex).toBe(2);
	});

	test("compares tab fields instead of relying on JSON key order", () => {
		const first = parseWorkspaceSessionState({
			bottom: {
				activeIndex: 0,
				tabs: [
					{ kind: "terminal", label: "Terminal", project: true, pinned: true },
				],
			},
			bottomOpen: true,
			right: { activeIndex: 0, tabs: [] },
			rightOpen: false,
		});
		const second = parseWorkspaceSessionState({
			bottom: {
				activeIndex: 0,
				tabs: [
					{ kind: "terminal", label: "Terminal", pinned: true, project: true },
				],
			},
			bottomOpen: true,
			right: { activeIndex: 0, tabs: [] },
			rightOpen: false,
		});

		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(sameWorkspaceSessionState(first, second)).toBe(true);
	});
});
