import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type {
	SessionSummary,
	ThreadTreeNode,
} from "@/src/lib/api/hierarchy.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const { buildSubagentTree } = await import("@/src/lib/subagent-tree.ts");
const { ThreadTreeList } = await import("./ThreadTreeList.tsx");

let container: HTMLDivElement;
let root: Root;
const opened: [string, string | undefined][] = [];
const open = (id: string, title?: string) => {
	opened.push([id, title]);
};

beforeEach(() => {
	opened.length = 0;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

function wire(
	id: string,
	parent: string | null,
	extra: Partial<SessionSummary> = {}
): ThreadTreeNode {
	return {
		conversation: {
			agent_id: null,
			id,
			message_count: 0,
			run_status: null,
			title: `Title ${id}`,
			updated_at: 1,
			...extra,
		},
		parent_id: parent,
	};
}

// root
//   a (running)
//     a1
//       a1x (failed)
//     a2 (no title)
//   b (completed, by Quill)
const NEST = [
	wire("root", null, { agent_id: "scout", thread_role: "main" }),
	wire("a", "root", { run_status: "running" }),
	wire("b", "root", { agent_id: "quill", run_status: "completed" }),
	wire("a1", "a"),
	wire("a2", "a", { title: null }),
	wire("a1x", "a1", { run_status: "failed" }),
];
const NAMES: Record<string, string> = { quill: "Quill", scout: "Scout" };

async function render(
	currentId = "a1",
	nodes: ThreadTreeNode[] = NEST,
	truncated = false
) {
	await act(async () => {
		root.render(
			<ThreadTreeList
				currentId={currentId}
				onOpenConversation={open}
				roots={buildSubagentTree(nodes, (id) => NAMES[id])}
				truncated={truncated}
			/>
		);
	});
}

const rows = () => [
	...container.querySelectorAll<HTMLElement>('[data-testid="thread-tree-row"]'),
];
const row = (id: string) => {
	const found = container.querySelector<HTMLElement>(`[data-tree-row="${id}"]`);
	if (!found) {
		throw new Error(`no row ${id}`);
	}
	return found;
};
const ids = () => rows().map((item) => item.getAttribute("data-tree-row"));
const focusedId = () => document.activeElement?.getAttribute("data-tree-row");

async function press(key: string, init: KeyboardEventInit = {}) {
	const from = document.activeElement;
	if (!from) {
		throw new Error("nothing is focused");
	}
	await act(async () => {
		from.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				key,
				...init,
			})
		);
	});
}

async function focus(id: string) {
	await act(async () => row(id).focus());
}

async function toggle(id: string) {
	await act(async () =>
		row(id)
			.querySelector<HTMLElement>('[data-testid="thread-tree-toggle"]')
			?.click()
	);
}

test("a three-level nest is listed as a tree, every row at its level", async () => {
	await render();
	const tree = container.querySelector('[data-testid="thread-tree"]');
	expect(tree?.getAttribute("role")).toBe("tree");
	expect(tree?.getAttribute("aria-label")).toBe("Session tree");
	expect(
		rows().map((item) => [
			item.getAttribute("data-tree-row"),
			item.getAttribute("aria-level"),
			item.getAttribute("aria-expanded"),
		])
	).toEqual([
		["root", "1", "true"],
		["a", "2", "true"],
		["a1", "3", "true"],
		["a1x", "4", null],
		["a2", "3", null],
		["b", "2", null],
	]);
	expect(rows().every((item) => item.getAttribute("role") === "treeitem")).toBe(
		true
	);
	// Deeper rows start further in, on the side reading starts.
	const indent = (id: string) =>
		Number.parseFloat(row(id).style.paddingInlineStart);
	expect(indent("a")).toBeGreaterThan(indent("root"));
	expect(indent("a1x")).toBeGreaterThan(indent("a1"));
	expect(indent("a2")).toBe(indent("a1"));
});

test("a row shows status, title and agent, and a thread without a title is a Session", async () => {
	await render();
	expect(row("a").textContent).toBe("Title aRunning");
	expect(
		row("a").querySelector("[data-run-status]")?.getAttribute("aria-label")
	).toBe("In progress");
	expect(row("b").textContent).toBe("Title bQuillDone");
	expect(row("a1x").textContent).toBe("Title a1xFailed");
	expect(row("a1").textContent).toBe("Title a1Idle");
	expect(row("a1").querySelector("[data-run-status]")).toBeNull();
	expect(row("a2").textContent).toBe("SessionIdle");
	expect(row("root").getAttribute("data-kind")).toBe("thread");
	expect(row("a").getAttribute("data-kind")).toBe("session");
	// Titles and agent names are the user's own words, so they are not translated.
	expect(row("b").querySelector('[data-ryu-i18n="off"]')?.textContent).toBe(
		"Title b"
	);
});

test("every row opens its own thread", async () => {
	await render();
	await act(async () => {
		for (const id of ["root", "a", "a1", "a1x", "a2", "b"]) {
			row(id).click();
		}
	});
	expect(opened).toEqual([
		["root", "Title root"],
		["a", "Title a"],
		["a1", "Title a1"],
		["a1x", "Title a1x"],
		["a2", undefined],
		["b", "Title b"],
	]);
});

test("the open thread is marked and takes Tab; the others do not", async () => {
	await render("a1");
	expect(row("a1").getAttribute("aria-current")).toBe("page");
	expect(
		rows().filter((item) => item.getAttribute("aria-current") !== null)
	).toHaveLength(1);
	expect(rows().map((item) => item.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1]);
});

test("the top row takes Tab when the open thread is not in the tree", async () => {
	await render("somewhere-else");
	expect(rows().map((item) => item.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
	expect(container.querySelector("[aria-current]")).toBeNull();
});

test("the fold button hides and shows what is below a row without opening it", async () => {
	await render();
	expect(
		row("a")
			.querySelector('[data-testid="thread-tree-toggle"]')
			?.getAttribute("aria-label")
	).toBe("Collapse Title a");
	await toggle("a");
	expect(ids()).toEqual(["root", "a", "b"]);
	expect(row("a").getAttribute("aria-expanded")).toBe("false");
	expect(
		row("a")
			.querySelector('[data-testid="thread-tree-toggle"]')
			?.getAttribute("aria-label")
	).toBe("Expand Title a");
	await toggle("a");
	expect(ids()).toEqual(["root", "a", "a1", "a1x", "a2", "b"]);
	expect(opened).toEqual([]);
	// A row with nothing below it has no button.
	expect(
		row("b").querySelector('[data-testid="thread-tree-toggle"]')
	).toBeNull();
});

test("arrow keys move between rows, Home and End jump, Enter and Space open", async () => {
	await render();
	await focus("a1");
	await press("ArrowDown");
	expect(focusedId()).toBe("a1x");
	await press("ArrowUp");
	await press("ArrowUp");
	expect(focusedId()).toBe("a");
	await press("End");
	expect(focusedId()).toBe("b");
	await press("ArrowDown");
	expect(focusedId()).toBe("b");
	await press("Home");
	expect(focusedId()).toBe("root");
	await press("ArrowUp");
	expect(focusedId()).toBe("root");
	await press("Enter");
	await press("ArrowDown");
	await press(" ");
	expect(opened).toEqual([
		["root", "Title root"],
		["a", "Title a"],
	]);
	// The row last focused is the one Tab comes back to.
	expect(row("a").tabIndex).toBe(0);
	expect(row("a1").tabIndex).toBe(-1);
});

test("the forward arrow unfolds then steps in; the backward arrow folds then steps out", async () => {
	await render();
	await focus("a");
	await press("ArrowLeft");
	expect(ids()).toEqual(["root", "a", "b"]);
	expect(focusedId()).toBe("a");
	// Folded: the backward arrow now goes to the parent.
	await press("ArrowLeft");
	expect(focusedId()).toBe("root");
	await press("ArrowDown");
	await press("ArrowRight");
	expect(ids()).toEqual(["root", "a", "a1", "a1x", "a2", "b"]);
	expect(focusedId()).toBe("a");
	// Unfolded: the forward arrow steps to the first row below.
	await press("ArrowRight");
	expect(focusedId()).toBe("a1");
	// A leaf has nothing to unfold; its backward arrow goes to the parent.
	await focus("a2");
	await press("ArrowRight");
	expect(focusedId()).toBe("a2");
	await press("ArrowLeft");
	expect(focusedId()).toBe("a");
	expect(opened).toEqual([]);
});

test("keys with a modifier are left alone", async () => {
	await render();
	await focus("a");
	await press("ArrowDown", { altKey: true });
	await press("ArrowLeft", { ctrlKey: true });
	await press("Enter", { metaKey: true });
	expect(focusedId()).toBe("a");
	expect(ids()).toHaveLength(6);
	expect(opened).toEqual([]);
});

test("right to left, the left arrow is the one that steps in", async () => {
	container.setAttribute("dir", "rtl");
	await render();
	await focus("a");
	await press("ArrowRight");
	expect(ids()).toEqual(["root", "a", "b"]);
	await press("ArrowLeft");
	expect(ids()).toEqual(["root", "a", "a1", "a1x", "a2", "b"]);
	await press("ArrowLeft");
	expect(focusedId()).toBe("a1");
	await press("ArrowRight");
	await press("ArrowRight");
	expect(focusedId()).toBe("a");
});

test("a tree cut by Core says so, and a whole one does not", async () => {
	await render("a1", NEST, true);
	expect(
		container.querySelector('[data-testid="thread-tree-truncated"]')
			?.textContent
	).toBe("Showing part of this session tree. It is too large to list in full.");
	await render("a1", NEST, false);
	expect(
		container.querySelector('[data-testid="thread-tree-truncated"]')
	).toBeNull();
});

test("threads with no visible thread above them are listed side by side", async () => {
	await render("mine", [
		wire("mine", null),
		wire("orphan", "hidden-from-me"),
		wire("below", "orphan"),
	]);
	expect(
		rows().map((item) => [
			item.getAttribute("data-tree-row"),
			item.getAttribute("aria-level"),
		])
	).toEqual([
		["mine", "1"],
		["orphan", "1"],
		["below", "2"],
	]);
});
