import { describe, expect, test } from "bun:test";
import {
	createDefaultWorkbench,
	type WorkbenchItem,
	type WorkbenchState,
} from "@ryu/workbench/model";
import type { WorkbenchAction } from "@ryu/workbench/reducer";
import type { WorkspaceSessionState } from "@/src/lib/workspace-session.ts";
import {
	baseToolLabel,
	hasDockSessionTabs,
	migrateDockSession,
} from "./dock-migration.ts";
import type {
	OpenPanelOptions,
	WorkbenchToolOption,
} from "./workbench-chrome.tsx";
import {
	emptyRegionPanel,
	isDockRegionShown,
	toggleDockRegion,
} from "./workbench-dock-bridge.tsx";

const TERMINAL: WorkbenchToolOption = {
	id: "terminal",
	label: "Terminal",
	region: "bottom",
};
const FILES: WorkbenchToolOption = {
	id: "files",
	label: "Files",
	region: "right",
};
const CONTEXT: WorkbenchToolOption = {
	conversation: { id: "conv-a", title: "Plan" },
	id: "context",
	label: "Context",
	region: "right",
};

function workbench(): WorkbenchState {
	return createDefaultWorkbench({
		bottomGroupId: "bottom-main",
		centerGroupId: "center-main",
		leftGroupId: "left-main",
		navigationId: "navigation",
		rightGroupId: "right-main",
	});
}

function withTab(state: WorkbenchState, region: "bottom" | "right") {
	const item: WorkbenchItem = {
		closable: true,
		duplicable: false,
		id: `${region}-tab`,
		pinned: false,
		preferredRegion: region,
		scope: { kind: "window" },
		source: { kind: "shell", panel: "files" },
		title: "Files",
	};
	return {
		...state,
		groups: state.groups.map((group) =>
			group.region === region
				? { ...group, activeItemId: item.id, itemIds: [item.id] }
				: group
		),
		items: [...state.items, item],
	};
}

function harness(state: WorkbenchState, folder: string | null = "/work/ryu") {
	const actions: WorkbenchAction[] = [];
	const opened: Array<{
		option: WorkbenchToolOption;
		options?: OpenPanelOptions;
	}> = [];
	const run = (
		region: "bottom" | "right",
		fallbacks?: readonly WorkbenchToolOption[]
	) =>
		toggleDockRegion(
			{
				dispatch: (action) => actions.push(action),
				folder,
				openPanel: (option, options) => {
					opened.push({ option, options });
					return "opened";
				},
				state,
				tools: [TERMINAL, FILES],
			},
			region,
			fallbacks
		);
	return { actions, opened, run };
}

describe("toggleDockRegion", () => {
	test("hides a region that is showing tabs", () => {
		const state = withTab(workbench(), "right");
		state.openRegions = { ...state.openRegions, right: true };
		expect(isDockRegionShown(state, "right")).toBe(true);
		const { actions, opened, run } = harness(state);
		run("right");
		expect(actions).toEqual([{ type: "region/hide", region: "right" }]);
		expect(opened).toEqual([]);
	});

	test("shows a hidden region that has tabs without opening another", () => {
		const { actions, opened, run } = harness(withTab(workbench(), "bottom"));
		run("bottom");
		expect(actions).toEqual([{ type: "region/show", region: "bottom" }]);
		expect(opened).toEqual([]);
	});

	test("opens the region's default tool in that region when it is empty", () => {
		const { actions, opened, run } = harness(workbench());
		run("bottom");
		run("right", [CONTEXT]);
		expect(actions).toEqual([]);
		expect(opened).toEqual([
			{
				option: TERMINAL,
				options: { groupId: "bottom-main", preserveFocus: true },
			},
			{
				option: FILES,
				options: { groupId: "right-main", preserveFocus: true },
			},
		]);
	});

	test("falls back to the chat's panel when no project is open", () => {
		const { opened, run } = harness(workbench(), null);
		run("right", [CONTEXT]);
		run("bottom");
		expect(opened).toEqual([
			{
				option: CONTEXT,
				options: { groupId: "right-main", preserveFocus: true },
			},
			// A terminal works without a project; Files does not.
			{
				option: TERMINAL,
				options: { groupId: "bottom-main", preserveFocus: true },
			},
		]);
	});

	test("opens another tool for the region when it has no default", () => {
		const app: WorkbenchToolOption = {
			id: "plugin:notes:panel",
			label: "Notes",
			region: "bottom",
		};
		expect(emptyRegionPanel([FILES, app], "bottom", null)).toEqual(app);
		expect(emptyRegionPanel([FILES], "right", null)).toBeUndefined();
	});
});

function session(
	right: WorkspaceSessionState["right"]["tabs"],
	bottom: WorkspaceSessionState["bottom"]["tabs"] = []
): WorkspaceSessionState {
	return {
		bottom: { activeIndex: 0, tabs: bottom },
		bottomOpen: true,
		right: { activeIndex: 0, tabs: right },
		rightOpen: true,
	};
}

describe("migrateDockSession", () => {
	test("reopens saved tabs in the background and drops dead ones", () => {
		const opened: Array<{
			option: WorkbenchToolOption;
			options?: OpenPanelOptions;
		}> = [];
		const saved = session(
			[
				{ kind: "context", label: "Context" },
				{ kind: "artifact", label: "Chart" },
				{ kind: "files", label: "Files", pinned: true, project: true },
				{ kind: "gitgraph", label: "Git graph", project: true },
				{ kind: "no-such-panel", label: "Gone" },
			],
			[{ kind: "terminal", label: "Terminal 2", project: true }]
		);
		expect(hasDockSessionTabs(saved)).toBe(true);
		migrateDockSession(saved, {
			conversation: CONTEXT.conversation,
			folder: "/work/ryu",
			openPanel: (option, options) => {
				opened.push({ option, options });
				return "id";
			},
		});
		expect(opened).toEqual([
			{
				option: {
					conversation: CONTEXT.conversation,
					id: "context",
					label: "Context",
					region: "right",
				},
				options: { activate: false },
			},
			{
				option: { id: "gitgraph", label: "Git graph", region: "right" },
				options: { activate: false, folder: "/work/ryu", forceNew: false },
			},
			{
				option: { id: "terminal", label: "Terminal", region: "bottom" },
				options: { activate: false, folder: "/work/ryu", forceNew: true },
			},
		]);
	});

	test("treats an empty session as nothing to migrate", () => {
		expect(hasDockSessionTabs(session([]))).toBe(false);
		expect(hasDockSessionTabs(undefined)).toBe(false);
	});

	test("strips copy numbers so reopened copies are renumbered", () => {
		expect(baseToolLabel("Terminal 3")).toBe("Terminal");
		expect(baseToolLabel("Git graph")).toBe("Git graph");
		expect(baseToolLabel("2")).toBe("2");
	});
});
