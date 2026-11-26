import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ComponentProps, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { HierarchyCrumb } from "@/src/lib/thread-hierarchy.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Flatten the menus so a trigger and its items are plain buttons in the DOM.
function Pass({ children }: { children?: ReactNode }) {
	return <div>{children}</div>;
}
mock.module("@ryu/ui/components/dropdown-menu.tsx", () => ({
	DropdownMenu: Pass,
	DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
		<div data-testid="menu">{children}</div>
	),
	DropdownMenuGroup: Pass,
	DropdownMenuItem: ({
		children,
		onClick,
	}: {
		children?: ReactNode;
		onClick?: () => void;
	}) => (
		<button data-testid="menu-item" onClick={onClick} type="button">
			{children}
		</button>
	),
	DropdownMenuLabel: Pass,
	DropdownMenuSeparator: () => null,
	DropdownMenuTrigger: ({ children, ...props }: ComponentProps<"button">) => (
		<button {...props} type="button">
			{children}
		</button>
	),
}));

const { createRoot } = await import("react-dom/client");
const { COMPACT_CRUMB_LIMIT } = await import("@/src/lib/thread-hierarchy.ts");
const { ThreadHierarchyCrumbs, useNarrowElement } = await import(
	"./ThreadHierarchyCrumbs.tsx"
);

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

function crumb(
	id: string,
	label: string,
	extra: Partial<HierarchyCrumb> = {}
): HierarchyCrumb {
	return {
		conversationId: id,
		id,
		kind: "session",
		label,
		siblings: [],
		...extra,
	};
}

/** Project, bot, then `sessions` nested sessions; the last one is current. */
function chain(sessions: number): HierarchyCrumb[] {
	const crumbs = [
		crumb("p", "Atlas", { kind: "project" }),
		crumb("b", "Scout", { kind: "bot", runStatus: "running" }),
		...Array.from({ length: sessions }, (_, index) =>
			crumb(`s${index + 1}`, `Session ${index + 1}`)
		),
	];
	const last = crumbs.at(-1);
	if (last) {
		last.conversationId = null;
	}
	return crumbs;
}

async function render(crumbs: HierarchyCrumb[], limit?: number) {
	await act(async () => {
		root.render(
			<ThreadHierarchyCrumbs
				crumbs={crumbs}
				limit={limit}
				onOpenConversation={open}
			/>
		);
	});
}

const all = (selector: string) => [
	...container.querySelectorAll<HTMLElement>(selector),
];
const visibleLabels = () =>
	all('[data-testid="crumb"]').map(
		(item) =>
			item.querySelector(
				"button[data-crumb-stop]:not([data-testid]), [aria-current=page]"
			)?.textContent
	);
const stops = () => all("[data-crumb-stop]");

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

test("a chain of four crumbs is shown whole, with no menu of hidden ones", async () => {
	await render(chain(2));
	expect(visibleLabels()).toEqual(["Atlas", "Scout", "Session 1", "Session 2"]);
	expect(all('[data-testid="crumb-hidden"]')).toHaveLength(0);
	// The current thread is the page, not a link.
	expect(container.querySelector("[aria-current=page]")?.textContent).toBe(
		"Session 2"
	);
});

test("a chain of five folds its middle into a menu that opens the hidden ancestors", async () => {
	await render(chain(3));
	expect(visibleLabels()).toEqual(["Atlas", "Session 2", "Session 3"]);
	const trigger = container.querySelector('[data-testid="crumb-hidden"]');
	expect(trigger?.getAttribute("aria-label")).toBe(
		"Show hidden parent threads"
	);
	const hidden = all('[data-testid="menu-item"]');
	expect(hidden.map((item) => item.textContent)).toEqual([
		"Scout",
		"Session 1",
	]);
	// The hidden bot keeps its status inside the menu.
	expect(
		hidden[0]?.querySelector("[data-run-status]")?.getAttribute("aria-label")
	).toBe("In progress");
	await act(async () => hidden[1]?.click());
	expect(opened).toEqual([["s1", "Session 1"]]);
});

test("a narrow bar keeps only the parent and the current crumb", async () => {
	await render(chain(3), COMPACT_CRUMB_LIMIT);
	expect(visibleLabels()).toEqual(["Session 2", "Session 3"]);
	expect(all('[data-testid="menu-item"]').map((i) => i.textContent)).toEqual([
		"Atlas",
		"Scout",
		"Session 1",
	]);
});

test("every crumb with a run status shows it as a labelled dot", async () => {
	await render([
		crumb("p", "Atlas", { kind: "project", runStatus: "failed" }),
		crumb("b", "Scout", { kind: "bot" }),
		crumb("s", "Audit", { conversationId: null, runStatus: "running" }),
	]);
	const dots = all('[data-testid="crumb"]').map((item) => {
		const dot = item.querySelector("[data-run-status]");
		return dot
			? [dot.getAttribute("data-run-status"), dot.getAttribute("aria-label")]
			: null;
	});
	expect(dots).toEqual([
		["failed", "Failed"],
		null,
		["running", "In progress"],
	]);
});

test("a crumb opens the threads beside it", async () => {
	await render([
		crumb("b", "Scout", { kind: "bot" }),
		crumb("s", "Audit", {
			conversationId: null,
			siblings: [
				{ conversationId: "s-new", label: "Deploy", runStatus: "running" },
				{ conversationId: "s-old", label: "Triage" },
			],
		}),
	]);
	const triggers = all('[data-testid="crumb-siblings"]');
	// Only the crumb that has threads beside it gets the menu.
	expect(triggers).toHaveLength(1);
	expect(triggers[0]?.getAttribute("aria-label")).toBe(
		"Other threads next to Audit"
	);
	const items = all('[data-testid="menu-item"]');
	expect(items.map((item) => item.textContent)).toEqual(["Deploy", "Triage"]);
	await act(async () => items[0]?.click());
	expect(opened).toEqual([["s-new", "Deploy"]]);
});

test("clicking an ancestor opens it", async () => {
	await render(chain(2));
	await act(async () => stops()[1]?.click());
	expect(opened).toEqual([["b", "Scout"]]);
});

test("arrow keys, Home and End move between the crumbs", async () => {
	await render(chain(3));
	// Atlas, the menu of hidden ancestors, Session 2. The current crumb is not
	// a link and has no threads beside it, so it is not a stop.
	const [first, hidden, parent] = stops();
	expect(stops()).toHaveLength(3);
	first?.focus();
	await press("ArrowRight");
	expect(document.activeElement).toBe(hidden ?? null);
	await press("ArrowRight");
	expect(document.activeElement).toBe(parent ?? null);
	// The end of the row holds focus instead of wrapping.
	await press("ArrowRight");
	expect(document.activeElement).toBe(parent ?? null);
	await press("ArrowLeft");
	expect(document.activeElement).toBe(hidden ?? null);
	await press("End");
	expect(document.activeElement).toBe(parent ?? null);
	await press("Home");
	expect(document.activeElement).toBe(first ?? null);
	// Moving focus opens nothing.
	expect(opened).toEqual([]);
});

test("arrow keys follow the reading direction", async () => {
	container.setAttribute("dir", "rtl");
	await render(chain(3));
	const [first, hidden] = stops();
	first?.focus();
	// Right to left, the next crumb is on the left.
	await press("ArrowRight");
	expect(document.activeElement).toBe(first ?? null);
	await press("ArrowLeft");
	expect(document.activeElement).toBe(hidden ?? null);
});

test("Alt+ArrowUp opens the parent from any crumb", async () => {
	await render(chain(3));
	stops()[0]?.focus();
	await press("ArrowUp", { altKey: true });
	expect(opened).toEqual([["s2", "Session 2"]]);
	expect(
		stops()
			.map((stop) => stop.getAttribute("aria-keyshortcuts"))
			.filter(Boolean)
	).toEqual(["Alt+ArrowUp"]);
});

test("Alt+ArrowUp does nothing on a thread with no parent crumb", async () => {
	await render([
		crumb("p", "Atlas", {
			conversationId: null,
			kind: "project",
			siblings: [{ conversationId: "x", label: "Other" }],
		}),
	]);
	stops()[0]?.focus();
	await press("ArrowUp", { altKey: true });
	expect(opened).toEqual([]);
});

test("useNarrowElement reports a bar narrower than the given width", async () => {
	const original = globalThis.ResizeObserver;
	const observed: { report: ((width: number) => void) | undefined } = {
		report: undefined,
	};
	class FakeResizeObserver {
		private readonly callback: ResizeObserverCallback;
		constructor(callback: ResizeObserverCallback) {
			this.callback = callback;
		}
		observe() {
			observed.report = (width) =>
				this.callback(
					[{ contentRect: { width } } as ResizeObserverEntry],
					this as unknown as ResizeObserver
				);
		}
		unobserve() {
			observed.report = undefined;
		}
		disconnect() {
			observed.report = undefined;
		}
	}
	Reflect.set(globalThis, "ResizeObserver", FakeResizeObserver);
	function Probe() {
		const [ref, narrow] = useNarrowElement(520);
		return <div data-narrow={String(narrow)} data-testid="probe" ref={ref} />;
	}
	try {
		await act(async () => root.render(<Probe />));
		const probe = container.querySelector('[data-testid="probe"]');
		// Nothing measured yet: the wide layout.
		expect(probe?.getAttribute("data-narrow")).toBe("false");
		await act(async () => observed.report?.(400));
		expect(probe?.getAttribute("data-narrow")).toBe("true");
		await act(async () => observed.report?.(900));
		expect(probe?.getAttribute("data-narrow")).toBe("false");
		// A hidden bar measures zero wide. That is not a narrow bar.
		await act(async () => observed.report?.(400));
		await act(async () => observed.report?.(0));
		expect(probe?.getAttribute("data-narrow")).toBe("true");
	} finally {
		Reflect.set(globalThis, "ResizeObserver", original);
	}
});
