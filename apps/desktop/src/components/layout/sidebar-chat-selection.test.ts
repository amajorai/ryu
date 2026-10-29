import { beforeEach, describe, expect, it } from "bun:test";
import type {
	DragEvent as ReactDragEvent,
	MouseEvent as ReactMouseEvent,
} from "react";
import {
	applySidebarChatSelectionClick,
	draggedSidebarChatIds,
	readSidebarChatDrag,
	SIDEBAR_CHATS_DND_MIME,
	startSidebarChatDrag,
	useSidebarChatSelection,
} from "./sidebar-chat-selection.tsx";

const ROW_IDS = ["a", "b", "c", "d", "e"];

/** A row element whose document lists ROW_IDS in visual order. */
function rowElement(): HTMLElement {
	const rows = ROW_IDS.map((id) => ({
		getAttribute: () => id,
	}));
	const ownerDocument = { querySelectorAll: () => rows };
	return { closest: () => null, ownerDocument } as unknown as HTMLElement;
}

function click(
	id: string,
	modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {},
	activeId: string | null = null
): boolean {
	const event = {
		ctrlKey: false,
		currentTarget: rowElement(),
		metaKey: false,
		shiftKey: false,
		...modifiers,
	} as unknown as ReactMouseEvent<HTMLElement>;
	return applySidebarChatSelectionClick(event, id, activeId);
}

function selected(): string[] {
	return [...useSidebarChatSelection.getState().selectedIds].sort();
}

describe("sidebar chat selection", () => {
	beforeEach(() => {
		useSidebarChatSelection.setState({
			anchorId: null,
			draggingIds: [],
			selectedIds: new Set(),
		});
	});

	it("lets a plain click through and clears the selection", () => {
		click("b", { metaKey: true });
		expect(click("c")).toBe(false);
		expect(selected()).toEqual([]);
	});

	it("shift-click selects the visual range from the last clicked row", () => {
		click("b");
		expect(click("d", { shiftKey: true })).toBe(true);
		expect(selected()).toEqual(["b", "c", "d"]);
		// The anchor stays put, so a second shift-click re-ranges from it.
		click("a", { shiftKey: true });
		expect(selected()).toEqual(["a", "b"]);
	});

	it("shift-click anchors on the open chat when nothing was clicked yet", () => {
		click("e", { shiftKey: true }, "c");
		expect(selected()).toEqual(["c", "d", "e"]);
	});

	it("cmd/ctrl-click toggles rows and includes the open chat first", () => {
		expect(click("d", { metaKey: true }, "a")).toBe(true);
		expect(selected()).toEqual(["a", "d"]);
		click("a", { ctrlKey: true }, "a");
		expect(selected()).toEqual(["d"]);
	});

	it("cmd+shift-click adds a range to the existing selection", () => {
		click("a", { metaKey: true });
		click("c");
		click("e", { metaKey: true, shiftKey: true });
		expect(selected()).toEqual(["c", "d", "e"]);
	});

	it("expands a visibility drop to the whole dragged selection", () => {
		useSidebarChatSelection.setState({ draggingIds: ["a", "b"] });
		expect(draggedSidebarChatIds("a")).toEqual(["a", "b"]);
		expect(draggedSidebarChatIds("z")).toEqual(["z"]);
	});
});

describe("sidebar chat drag payload", () => {
	const transfer = (raw: string) =>
		({
			getData: (format: string) =>
				format === SIDEBAR_CHATS_DND_MIME ? raw : "",
		}) as unknown as DataTransfer;

	it("reads the dragged ids", () => {
		expect(readSidebarChatDrag(transfer('{"ids":["a","b"]}'))).toEqual([
			"a",
			"b",
		]);
	});

	it("rejects foreign or malformed payloads", () => {
		expect(readSidebarChatDrag(transfer(""))).toBeNull();
		expect(readSidebarChatDrag(transfer("not json"))).toBeNull();
		expect(readSidebarChatDrag(transfer('{"ids":[1,""]}'))).toBeNull();
		expect(readSidebarChatDrag(transfer('{"id":"a"}'))).toBeNull();
	});
});

describe("sidebar chat drag lifecycle", () => {
	const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

	/** A row dragstart whose window is `view`; the row itself may be gone later. */
	function dragStartIn(view: EventTarget): ReactDragEvent<HTMLElement> {
		return {
			currentTarget: { ownerDocument: { defaultView: view } },
			dataTransfer: { setData: () => undefined },
		} as unknown as ReactDragEvent<HTMLElement>;
	}

	beforeEach(() => {
		useSidebarChatSelection.setState({
			dragging: false,
			draggingIds: [],
			selectedIds: new Set(),
		});
	});

	it("ends the drag on a window drop even when the source row unmounted", async () => {
		const view = new EventTarget();
		startSidebarChatDrag(dragStartIn(view), "a");
		await nextTask();
		expect(useSidebarChatSelection.getState().dragging).toBe(true);

		view.dispatchEvent(new Event("drop"));
		await nextTask();
		expect(useSidebarChatSelection.getState().dragging).toBe(false);
		// The ids stay for a visibility drop that reads them late.
		expect(useSidebarChatSelection.getState().draggingIds).toEqual(["a"]);
	});

	it("ends a cancelled drag on the window dragend", async () => {
		const view = new EventTarget();
		startSidebarChatDrag(dragStartIn(view), "a");
		await nextTask();
		view.dispatchEvent(new Event("dragend"));
		await nextTask();
		expect(useSidebarChatSelection.getState().dragging).toBe(false);
	});

	it("only the current drag's window listener ends the drag", async () => {
		const first = new EventTarget();
		const second = new EventTarget();
		startSidebarChatDrag(dragStartIn(first), "a");
		startSidebarChatDrag(dragStartIn(second), "b");
		await nextTask();
		first.dispatchEvent(new Event("drop"));
		await nextTask();
		expect(useSidebarChatSelection.getState().dragging).toBe(true);
		second.dispatchEvent(new Event("drop"));
		await nextTask();
		expect(useSidebarChatSelection.getState().dragging).toBe(false);
	});
});
