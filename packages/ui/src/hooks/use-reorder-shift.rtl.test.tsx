import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type ReorderShift, useReorderShift } from "./use-reorder-shift.tsx";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Three 20px tabs in a right-to-left row with 4px gaps: A is drawn rightmost.
const RECTS: Record<string, { left: number; right: number }> = {
	a: { left: 280, right: 300 },
	b: { left: 256, right: 276 },
	c: { left: 232, right: 252 },
};
const IDS = ["a", "b", "c"] as const;

let latest: ReorderShift | undefined;

function Strip({
	activeId,
	before,
	direction,
	overId,
}: {
	activeId: string | null;
	before?: boolean;
	direction: "ltr" | "rtl";
	overId: string | null;
}) {
	const shift = useReorderShift({ activeId, axis: "x", before, overId });
	latest = shift;
	return (
		<div data-strip="" style={{ direction }}>
			{IDS.map((id) => (
				<span data-tab={id} key={id} ref={shift.register(id)} />
			))}
		</div>
	);
}

function stubRects() {
	for (const id of IDS) {
		const tab = document.querySelector<HTMLElement>(`[data-tab="${id}"]`);
		const rect = RECTS[id];
		if (!(tab && rect)) {
			throw new Error(`tab ${id} did not render`);
		}
		tab.getBoundingClientRect = () =>
			new DOMRect(rect.left, 0, rect.right - rect.left, 20) as DOMRect;
	}
}

function current(): ReorderShift {
	if (!latest) {
		throw new Error("strip did not mount");
	}
	return latest;
}

describe("useReorderShift in a right-to-left row", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		latest = undefined;
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});

	async function render(
		props: Parameters<typeof Strip>[0]
	): Promise<ReorderShift> {
		await act(async () => root.render(<Strip {...props} />));
		return current();
	}

	test("dragging the first tab after the last slides it to the left", async () => {
		await render({ activeId: null, direction: "rtl", overId: null });
		stubRects();
		const shift = await render({
			activeId: "a",
			before: false,
			direction: "rtl",
			overId: "c",
		});
		expect(shift.previewing).toBe(true);
		// A travels left into C's slot; B and C step right by A's pitch.
		expect(shift.styleFor("a")?.transform).toBe("translateX(-48px)");
		expect(shift.styleFor("b")?.transform).toBe("translateX(24px)");
		expect(shift.styleFor("c")?.transform).toBe("translateX(24px)");
	});

	test("resolveOver maps the pointer to the resting slot drawn under it", async () => {
		await render({ activeId: null, direction: "rtl", overId: null });
		stubRects();
		const shift = await render({
			activeId: "a",
			direction: "rtl",
			overId: null,
		});
		// Mid-drag B and C have slid right one slot: B is drawn where A rested
		// and C where B rested. The pointer over those drawn elements targets
		// the resting slot beneath it, not the element that slid there.
		const moveTab = (id: string, left: number) => {
			const tab = document.querySelector<HTMLElement>(`[data-tab="${id}"]`);
			if (tab) {
				tab.getBoundingClientRect = () =>
					new DOMRect(left, 0, 20, 20) as DOMRect;
			}
		};
		moveTab("b", 280);
		moveTab("c", 256);
		expect(shift.resolveOver<string>("b", 290, 10)).toBe("a");
		expect(shift.resolveOver<string>("c", 266, 10)).toBe("b");
	});

	test("the same geometry left to right keeps physical offsets", async () => {
		await render({ activeId: null, direction: "ltr", overId: null });
		stubRects();
		const shift = await render({
			activeId: "c",
			before: false,
			direction: "ltr",
			overId: "a",
		});
		// LTR reads C, B, A by x: dropping C after A moves it right.
		expect(shift.styleFor("c")?.transform).toBe("translateX(48px)");
		expect(shift.styleFor("a")?.transform).toBe("translateX(-24px)");
	});
});
