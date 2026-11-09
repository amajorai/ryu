import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
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

const tl: LiteralMessage = (source, values) => formatMessage(source, values);

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
		dir: "ltr",
		dispatch,
		movableRegions: DESKTOP_SHELL_REGIONS,
		state,
		tl,
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
		dir: "ltr",
		dispatch: () => undefined,
		movableRegions: DESKTOP_SHELL_REGIONS,
		state,
		tl,
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
			dir: "ltr",
			dispatch: () => undefined,
			movableRegions: DESKTOP_SHELL_REGIONS,
			state: fixture(),
			tl,
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

describe("bottom alignment titles", () => {
	test("each title is one whole translated message with no English label", () => {
		const catalog: Record<string, string> = {
			"Align Bottom Pane: Center": "下部ペインを揃える: 中央",
			"Align Bottom Pane: Full width": "下部ペインを揃える: 全幅",
			"Align Bottom Pane: Left": "下部ペインを揃える: 左",
			"Align Bottom Pane: Right": "下部ペインを揃える: 右",
		};
		const japanese: LiteralMessage = (source, values) =>
			formatMessage(catalog[source] ?? source, values);
		const titles = workbenchLayoutCommands({
			dir: "ltr",
			dispatch: () => undefined,
			movableRegions: DESKTOP_SHELL_REGIONS,
			state: fixture(),
			tl: japanese,
		})
			.filter((command) => command.id.startsWith("workbench-align-bottom-"))
			.map((command) => [command.id, command.title]);
		expect(Object.fromEntries(titles)).toEqual({
			"workbench-align-bottom-center": "下部ペインを揃える: 中央",
			"workbench-align-bottom-full": "下部ペインを揃える: 全幅",
			"workbench-align-bottom-left": "下部ペインを揃える: 左",
			"workbench-align-bottom-right": "下部ペインを揃える: 右",
		});
	});
});

function titlesUnder(
	dir: "ltr" | "rtl",
	translate: LiteralMessage,
	state: WorkbenchState = fixture()
): Record<string, string> {
	return Object.fromEntries(
		workbenchLayoutCommands({
			dir,
			dispatch: () => undefined,
			movableRegions: DESKTOP_SHELL_REGIONS,
			state,
			tl: translate,
		}).map((command) => [command.id, command.title])
	);
}

describe("right-to-left titles", () => {
	test("rtl: commands name the side a pane is drawn on, not its stored id", () => {
		const titles = titlesUnder("rtl", tl);
		// The persisted `right` region is drawn on screen-left under RTL.
		expect(titles["workbench-toggle-right"]).toBe("Show Left Pane");
		expect(titles["workbench-move-to-right"]).toBe("Move Tab to Left Pane");
		expect(titles["workbench-align-bottom-left"]).toBe(
			"Align Bottom Pane: Right"
		);
		expect(titles["workbench-align-bottom-right"]).toBe(
			"Align Bottom Pane: Left"
		);
		// Navigation sits in `left` (screen-right), so its move goes to screen-left.
		expect(titles["workbench-navigation-right"]).toBe(
			"Move Navigation to Left"
		);
	});

	test("ltr: titles keep the stored side", () => {
		const titles = titlesUnder("ltr", tl);
		expect(titles["workbench-toggle-right"]).toBe("Show Right Pane");
		expect(titles["workbench-navigation-right"]).toBe(
			"Move Navigation to Right"
		);
	});

	test("rtl: the dispatched region is still the stored one", () => {
		let next = fixture();
		const command = workbenchLayoutCommands({
			dir: "rtl",
			dispatch: (action) => {
				next = reduceWorkbench(next, action);
			},
			movableRegions: DESKTOP_SHELL_REGIONS,
			state: next,
			tl,
		}).find((candidate) => candidate.id === "workbench-move-to-right");
		command?.run();
		expect(
			next.groups.find((group) => group.region === "right")?.itemIds
		).toEqual(["c"]);
	});

	test("ar: every layout title is one translated message with no English", () => {
		const catalog: Record<string, string> = {
			Bottom: "أسفل",
			Center: "الوسط",
			"Equalize Center Panes": "مساواة الأجزاء الوسطى",
			"Focus Next Pane": "التركيز على الجزء التالي",
			"Focus Previous Pane": "التركيز على الجزء السابق",
			"Hide {name} Pane": "إخفاء الجزء {name}",
			"Join Center Panes": "دمج الأجزاء الوسطى",
			Left: "يسار",
			"Move Navigation to Left": "نقل التنقل إلى اليسار",
			"Move Tab to {name} Pane": "نقل علامة التبويب إلى الجزء {name}",
			"Reset Layout": "إعادة تعيين التخطيط",
			Right: "يمين",
			"Show {name} Pane": "إظهار الجزء {name}",
			"Align Bottom Pane: Center": "محاذاة الجزء السفلي: الوسط",
			"Align Bottom Pane: Full width": "محاذاة الجزء السفلي: العرض الكامل",
			"Align Bottom Pane: Left": "محاذاة الجزء السفلي: يسار",
			"Align Bottom Pane: Right": "محاذاة الجزء السفلي: يمين",
		};
		const arabic: LiteralMessage = (source, values) =>
			formatMessage(catalog[source] ?? source, values);
		const titles = titlesUnder("rtl", arabic);
		expect(titles["workbench-toggle-right"]).toBe("إظهار الجزء يسار");
		expect(titles["workbench-navigation-right"]).toBe("نقل التنقل إلى اليسار");
		expect(titles["workbench-reset-layout"]).toBe("إعادة تعيين التخطيط");
		for (const title of Object.values(titles)) {
			expect(title).not.toMatch(/[A-Za-z]/);
		}
	});
});
