import { describe, expect, test } from "bun:test";
import { createDefaultWorkbench } from "@ryu/workbench/model";
import { reduceWorkbench, type WorkbenchAction } from "@ryu/workbench/reducer";
import {
	applyWorkbenchPaneDrop,
	splitTargetGroupId,
	stripDropIndex,
} from "./workbench-drop.ts";

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

function fixture() {
	let state = createDefaultWorkbench({
		bottomGroupId: "bottom-main",
		centerGroupId: "center-main",
		leftGroupId: "left-main",
		navigationId: "navigation",
		rightGroupId: "right-main",
	});
	for (const [id, groupId] of [
		["a", "center-main"],
		["b", "center-main"],
		["files", "right-main"],
	] as const) {
		state = reduceWorkbench(state, {
			type: "item/open",
			groupId,
			item: routeItem(id),
		});
	}
	return state;
}

function run(
	state: ReturnType<typeof fixture>,
	apply: (dispatch: (action: WorkbenchAction) => void) => void
) {
	let next = state;
	apply((action) => {
		next = reduceWorkbench(next, action);
	});
	return next;
}

describe("stripDropIndex", () => {
	test("counts positions without the dragged tab", () => {
		expect(stripDropIndex(["a", "b", "c"], "a", "c", true)).toBe(1);
		expect(stripDropIndex(["a", "b", "c"], "a", "c", false)).toBe(2);
		expect(stripDropIndex(["a", "b"], "x", "a", true)).toBe(0);
		expect(stripDropIndex(["a", "b"], "x", null, false)).toBe(2);
		expect(stripDropIndex(["a", "b"], "x", "missing", true)).toBe(2);
	});
});

describe("applyWorkbenchPaneDrop", () => {
	test("moves a side-region tab into a Center group without swapping", () => {
		const state = fixture();
		const next = run(state, (dispatch) =>
			applyWorkbenchPaneDrop({
				dispatch,
				draggingId: "files",
				state,
				targetGroupId: "center-main",
				zone: "center",
			})
		);
		const center = next.groups.find((group) => group.id === "center-main");
		const right = next.groups.find((group) => group.id === "right-main");
		expect(center?.itemIds).toEqual(["a", "b", "files"]);
		expect(center?.activeItemId).toBe("files");
		expect(right?.itemIds).toEqual([]);
	});

	test("splits Center from a side-region tab", () => {
		const state = fixture();
		const next = run(state, (dispatch) =>
			applyWorkbenchPaneDrop({
				dispatch,
				draggingId: "files",
				makeGroupId: () => "center-new",
				state,
				targetGroupId: "center-main",
				zone: "right",
			})
		);
		expect(next.centerTree).toMatchObject({
			type: "branch",
			orientation: "columns",
		});
		expect(
			next.groups.find((group) => group.id === "center-new")?.itemIds
		).toEqual(["files"]);
	});
});

describe("splitTargetGroupId", () => {
	test("uses the item's own Center group, else the focused Center group", () => {
		const state = fixture();
		expect(splitTargetGroupId(state, "a")).toBe("center-main");
		expect(splitTargetGroupId(state, "files")).toBe("center-main");
	});
});
