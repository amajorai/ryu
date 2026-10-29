import { describe, expect, test } from "bun:test";
import {
	createDefaultWorkbench,
	type WorkbenchState,
} from "@ryu/workbench/model";
import { reduceWorkbench, type WorkbenchAction } from "@ryu/workbench/reducer";
import { DESKTOP_SHELL_REGIONS } from "./workbench-chrome.tsx";
import {
	adjacentGroupId,
	visibleGroupOrder,
	workbenchLayoutCommands,
} from "./workbench-commands.ts";

function routeItem(id: string) {
	return {
		closable: true,
		duplicable: true,
		id,
		pinned: false,
		preferredRegion: "center" as const,
		scope: { kind: "window" as const },
		source: { kind: "route" as const, path: `/${id}` },
		title: id,
	};
}

function fixture(): WorkbenchState {
	let state = createDefaultWorkbench({
		bottomGroupId: "bottom-main",
		centerGroupId: "center-main",
		leftGroupId: "left-main",
		navigationId: "navigation",
		rightGroupId: "right-main",
	});
	for (const id of ["a", "b", "c"]) {
		state = reduceWorkbench(state, {
			type: "item/open",
			groupId: "center-main",
			item: routeItem(id),
		});
	}
	return state;
}

function runCommand(state: WorkbenchState, id: string): WorkbenchState {
	let next = state;
	const dispatch = (action: WorkbenchAction) => {
		next = reduceWorkbench(next, action);
	};
	const command = workbenchLayoutCommands({
		dispatch,
		movableRegions: DESKTOP_SHELL_REGIONS,
		state,
	}).find((candidate) => candidate.id === id);
	if (!command) {
		throw new Error(`Missing command ${id}`);
	}
	if (command.disabled) {
		throw new Error(`Command ${id} is disabled`);
	}
	command.run();
	return next;
}

function commandById(state: WorkbenchState, id: string) {
	return workbenchLayoutCommands({
		dispatch: () => undefined,
		movableRegions: DESKTOP_SHELL_REGIONS,
		state,
	}).find((candidate) => candidate.id === id);
}

describe("workbenchLayoutCommands", () => {
	test("moves the focused tab between panes and toggles the region it reaches", () => {
		let state = runCommand(fixture(), "workbench-move-to-bottom");
		const bottom = state.groups.find((group) => group.region === "bottom");
		expect(bottom?.itemIds).toEqual(["c"]);
		expect(state.openRegions.bottom).toBe(true);
		expect(commandById(state, "workbench-move-to-bottom")?.disabled).toBe(true);
		expect(commandById(state, "workbench-toggle-bottom")?.title).toBe(
			"Hide Bottom Pane"
		);
		state = runCommand(state, "workbench-toggle-bottom");
		expect(state.openRegions.bottom).toBe(false);
		expect(commandById(state, "workbench-toggle-right")?.disabled).toBe(true);
		// Hiding Bottom returns focus to Center, so moving there needs the tab
		// focused again (which also reveals Bottom).
		expect(commandById(state, "workbench-move-to-center")?.disabled).toBe(true);
		state = reduceWorkbench(state, { type: "item/activate", itemId: "c" });
		expect(state.openRegions.bottom).toBe(true);
		state = runCommand(state, "workbench-move-to-center");
		expect(
			state.groups.find((group) => group.id === "center-main")?.itemIds
		).toContain("c");
	});

	test("offers no Left move while the Desktop shell keeps Left for navigation", () => {
		const ids = workbenchLayoutCommands({
			dispatch: () => undefined,
			movableRegions: DESKTOP_SHELL_REGIONS,
			state: fixture(),
		}).map((command) => command.id);
		expect(ids).not.toContain("workbench-move-to-left");
		expect(ids).toContain("workbench-reset-layout");
	});

	test("equalizes and joins Center panes", () => {
		let state = fixture();
		state = reduceWorkbench(state, {
			type: "center/split",
			direction: "right",
			newGroupId: "center-2",
			targetGroupId: "center-main",
		});
		state = reduceWorkbench(state, {
			type: "item/move",
			itemId: "c",
			toGroupId: "center-2",
		});
		state = reduceWorkbench(state, {
			type: "center/resize-branch",
			path: [],
			sizes: [0.8, 0.2],
		});
		state = runCommand(state, "workbench-equalize-center");
		expect(state.centerTree).toMatchObject({ sizes: [0.5, 0.5] });
		state = runCommand(state, "workbench-join-center");
		expect(state.centerTree).toEqual({ type: "leaf", groupId: "center-main" });
		expect(
			state.groups.find((group) => group.id === "center-main")?.itemIds
		).toEqual(["a", "b", "c"]);
		expect(commandById(state, "workbench-join-center")?.disabled).toBe(true);
	});

	test("marks the current Bottom alignment and changes it", () => {
		let state = fixture();
		expect(commandById(state, "workbench-align-bottom-center")?.checked).toBe(
			true
		);
		state = runCommand(state, "workbench-align-bottom-full");
		expect(state.bottomAlignment).toBe("full");
	});
});

describe("navigation placement", () => {
	test("moves Navigation to Right and back to Left by command", () => {
		let state = fixture();
		expect(commandById(state, "workbench-navigation-right")?.title).toBe(
			"Move Navigation to Right"
		);
		state = runCommand(state, "workbench-navigation-right");
		const right = state.groups.find((group) => group.region === "right");
		expect(right?.itemIds).toEqual(["navigation"]);
		expect(state.openRegions.right).toBe(true);
		expect(commandById(state, "workbench-navigation-right")).toBeUndefined();
		state = runCommand(state, "workbench-navigation-left");
		expect(
			state.groups.find((group) => group.region === "left")?.itemIds
		).toEqual(["navigation"]);
	});
});

describe("pane focus order", () => {
	test("cycles visible groups in reading order and skips hidden or empty regions", () => {
		let state = fixture();
		state = reduceWorkbench(state, {
			type: "item/move",
			itemId: "c",
			toGroupId: "right-main",
		});
		expect(visibleGroupOrder(state, DESKTOP_SHELL_REGIONS)).toEqual([
			"center-main",
			"right-main",
		]);
		expect(state.focusedGroupId).toBe("right-main");
		expect(adjacentGroupId(state, DESKTOP_SHELL_REGIONS, 1)).toBe(
			"center-main"
		);
		state = reduceWorkbench(state, { type: "region/hide", region: "right" });
		expect(adjacentGroupId(state, DESKTOP_SHELL_REGIONS, 1)).toBeUndefined();
	});
});
