// Tab while editing a cell must move along the reading order, exactly like
// Tab outside edit mode. Cell editors report Tab as "right" and Shift+Tab as
// "left"; `navigateCell` treats those as physical sides, so under dir="rtl"
// the commit path has to swap them or Tab jumps to the previous column.

import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DataGridState } from "@ryu/ui/hooks/use-data-grid-model.ts";
import type { CellPosition, Direction } from "@ryu/ui/types/data-grid.ts";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const { useDataGridFill } = await import("./use-data-grid-fill.ts");
const { useDataGridNavigation } = await import("./use-data-grid-navigation.ts");
const { handleDataGridNavigationKey } = await import(
	"./use-data-grid-key-navigation.ts"
);

type NavigationContext = Parameters<typeof useDataGridNavigation>[0];
type GridApi = ReturnType<typeof useDataGridFill>;

const COLUMNS = ["name", "email", "phone"];
const ROWS = [
	{ name: "a", email: "a@x", phone: "1" },
	{ name: "b", email: "b@x", phone: "2" },
];

interface FakeStoreState {
	editingCell: CellPosition | null;
	focusedCell: CellPosition | null;
	rowSelection: Record<string, boolean>;
	selectionState: DataGridState["selectionState"];
}

function createFakeStore(start: CellPosition) {
	const state: FakeStoreState = {
		editingCell: start,
		focusedCell: start,
		rowSelection: {},
		selectionState: {
			selectedCells: new Set(),
			selectionRange: null,
			isSelecting: false,
		},
	};
	return {
		state,
		store: {
			batch: (fn: () => void) => fn(),
			getState: () => state,
			notify: () => undefined,
			setState: (key: keyof FakeStoreState, value: never) => {
				state[key] = value;
			},
			subscribe: () => () => undefined,
		},
	};
}

function buildContext(dir: Direction, start: CellPosition) {
	const { state, store } = createFakeStore(start);
	const focusCell = (rowIndex: number, columnId: string) => {
		state.focusedCell = { rowIndex, columnId };
	};
	const table = {
		getColumn: () => undefined,
		getRowModel: () => ({
			rows: ROWS.map((row) => ({
				getValue: (id: string) => row[id as keyof typeof row],
			})),
		}),
	};
	const context = {
		applyDataUpdate: () => undefined,
		cellMapRef: { current: new Map() },
		columnIds: COLUMNS,
		committedValueRef: { current: null },
		dataGridRef: { current: null },
		dir,
		fillOnCommitRef: { current: null },
		focusCell,
		focusCellWrapper: focusCell,
		footerRef: { current: null },
		headerRef: { current: null },
		navigableColumnIds: COLUMNS,
		onDataUpdate: () => undefined,
		propsRef: { current: { data: ROWS, readOnly: false } },
		pushHistory: () => undefined,
		restoreFocus: () => undefined,
		rowHeight: "short",
		rowMapRef: { current: new Map() },
		rowVirtualizerRef: { current: null },
		selectRange: () => undefined,
		store,
		tableRef: { current: table },
	} as unknown as NavigationContext;
	return { context, state };
}

let api: GridApi | undefined;

function Harness({ context }: { context: NavigationContext }) {
	api = useDataGridFill(useDataGridNavigation(context));
	return null;
}

const roots: Root[] = [];
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	api = undefined;
});

async function mountGrid(dir: Direction, start: CellPosition) {
	const built = buildContext(dir, start);
	const root = createRoot(document.createElement("div"));
	roots.push(root);
	await act(async () => {
		root.render(<Harness context={built.context} />);
	});
	if (!api) {
		throw new Error("grid hooks did not mount");
	}
	return { api, state: built.state };
}

function nextFrame(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => resolve());
	});
}

/** Commit the open editor the way a cell variant does on (Shift+)Tab. */
async function commitWithTab(
	dir: Direction,
	shiftKey: boolean
): Promise<string | undefined> {
	const { api: grid, state } = await mountGrid(dir, {
		rowIndex: 0,
		columnId: "email",
	});
	await act(async () => {
		grid.onCellEditingStop({ direction: shiftKey ? "left" : "right" });
		await nextFrame();
	});
	if (state.editingCell !== null) {
		throw new Error("the editor stayed open after the Tab commit");
	}
	return state.focusedCell?.columnId;
}

/** Press (Shift+)Tab on a focused cell outside edit mode. */
async function tabOutsideEdit(
	dir: Direction,
	shiftKey: boolean
): Promise<string | undefined> {
	const start = { rowIndex: 0, columnId: "email" };
	const { api: grid, state } = await mountGrid(dir, start);
	state.editingCell = null;
	const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey });
	handleDataGridNavigationKey({
		...(grid as unknown as Parameters<typeof handleDataGridNavigationKey>[0]),
		altKey: false,
		blurCell: () => undefined,
		currentState: {
			...(state as unknown as DataGridState),
			focusedCell: start,
		},
		dir,
		event,
		isCtrlPressed: false,
		key: "Tab",
		onSelectionClear: () => undefined,
		shiftKey,
	});
	return state.focusedCell?.columnId;
}

describe("useDataGridFill Tab commit under dir", () => {
	test("rtl: Tab after editing moves to the next column", async () => {
		expect(await commitWithTab("rtl", false)).toBe("phone");
	});

	test("rtl: Shift+Tab after editing moves back to the previous column", async () => {
		expect(await commitWithTab("rtl", true)).toBe("name");
	});

	test("rtl: committing with Tab lands where Tab outside edit mode does", async () => {
		expect(await tabOutsideEdit("rtl", false)).toBe("phone");
		expect(await tabOutsideEdit("rtl", true)).toBe("name");
		expect(await commitWithTab("rtl", false)).toBe(
			await tabOutsideEdit("rtl", false)
		);
		expect(await commitWithTab("rtl", true)).toBe(
			await tabOutsideEdit("rtl", true)
		);
	});

	test("ltr: Tab and Shift+Tab after editing keep their order", async () => {
		expect(await commitWithTab("ltr", false)).toBe("phone");
		expect(await commitWithTab("ltr", true)).toBe("name");
		expect(await tabOutsideEdit("ltr", false)).toBe("phone");
	});
});
