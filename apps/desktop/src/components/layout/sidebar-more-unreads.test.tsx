import { afterEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const {
	findOffscreenUnreads,
	SIDEBAR_UNREAD_ROW_ATTRIBUTE,
	SidebarMoreUnreads,
	sidebarUnreadRowAttributes,
} = await import("./sidebar-more-unreads.tsx");

const VIEWPORT = { top: 100, bottom: 400 };

describe("findOffscreenUnreads", () => {
	it("reports nothing when every unread row is in view", () => {
		expect(
			findOffscreenUnreads(VIEWPORT, [
				{ top: 120, bottom: 150 },
				{ top: 360, bottom: 390 },
			])
		).toEqual({ nearestAbove: null, nearestBelow: null });
	});

	it("keeps the nearest row on each side", () => {
		expect(
			findOffscreenUnreads(VIEWPORT, [
				{ top: 0, bottom: 30 },
				{ top: 50, bottom: 80 },
				{ top: 500, bottom: 530 },
				{ top: 420, bottom: 450 },
			])
		).toEqual({ nearestAbove: 50, nearestBelow: 50 });
	});

	it("treats a row as offscreen once its center leaves the viewport", () => {
		// Center 95 is above the top edge; center 105 is still inside.
		expect(
			findOffscreenUnreads(VIEWPORT, [{ top: 80, bottom: 110 }]).nearestAbove
		).toBe(20);
		expect(
			findOffscreenUnreads(VIEWPORT, [{ top: 90, bottom: 120 }]).nearestAbove
		).toBeNull();
	});
});

describe("sidebarUnreadRowAttributes", () => {
	it("marks only unread rows", () => {
		expect(sidebarUnreadRowAttributes(true)).toEqual({
			[SIDEBAR_UNREAD_ROW_ATTRIBUTE]: "true",
		});
		expect(sidebarUnreadRowAttributes(false)).toEqual({
			[SIDEBAR_UNREAD_ROW_ATTRIBUTE]: undefined,
		});
	});
});

function rect(top: number, bottom: number): DOMRect {
	return {
		bottom,
		height: bottom - top,
		left: 0,
		right: 200,
		top,
		width: 200,
		x: 0,
		y: top,
		toJSON: () => ({}),
	};
}

/** Rows laid out 40px apart; the scroller shows y 0–200 at scrollTop 0. */
function Harness({ unread }: { unread: readonly number[] }) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	return (
		<div ref={containerRef}>
			<SidebarMoreUnreads containerRef={containerRef} />
			<div data-slot="sidebar-content">
				{Array.from({ length: 20 }, (_, index) => (
					<div
						data-row-index={index}
						key={index}
						{...sidebarUnreadRowAttributes(unread.includes(index))}
					/>
				))}
			</div>
		</div>
	);
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});

function mount(unread: readonly number[]) {
	host = document.createElement("div");
	document.body.append(host);
	const scrollState = { top: 0 };
	const originalRect = HTMLElement.prototype.getBoundingClientRect;
	HTMLElement.prototype.getBoundingClientRect = function boundingRect() {
		if (this.dataset.slot === "sidebar-content") {
			return rect(0, 200);
		}
		const index = this.dataset.rowIndex;
		if (index !== undefined) {
			const top = Number(index) * 40 - scrollState.top;
			return rect(top, top + 32);
		}
		return originalRect.call(this);
	};
	act(() => {
		root = createRoot(host as HTMLElement);
		root.render(<Harness unread={unread} />);
	});
	return {
		restore: () => {
			HTMLElement.prototype.getBoundingClientRect = originalRect;
		},
		scrollTo: (top: number) => {
			scrollState.top = top;
			const scroller = host?.querySelector('[data-slot="sidebar-content"]');
			act(() => {
				scroller?.dispatchEvent(new Event("scroll"));
			});
		},
	};
}

async function nextFrame() {
	await act(
		() =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() => resolve());
			})
	);
}

describe("SidebarMoreUnreads", () => {
	it("shows a pill for each direction holding offscreen unread rows", async () => {
		const view = mount([1, 15]);
		try {
			expect(host?.querySelector("[data-testid=sidebar-more-unreads-up]")).toBe(
				null
			);
			expect(
				host?.querySelector("[data-testid=sidebar-more-unreads-down]")
			).not.toBe(null);

			view.scrollTo(460);
			await nextFrame();
			expect(
				host?.querySelector("[data-testid=sidebar-more-unreads-up]")
			).not.toBe(null);
			expect(
				host?.querySelector("[data-testid=sidebar-more-unreads-down]")
			).toBe(null);
		} finally {
			view.restore();
		}
	});

	it("scrolls the nearest offscreen unread row into view", () => {
		const view = mount([8, 15]);
		try {
			const scroller = host?.querySelector<HTMLElement>(
				'[data-slot="sidebar-content"]'
			);
			const calls: ScrollToOptions[] = [];
			if (scroller) {
				scroller.scrollBy = ((options: ScrollToOptions) => {
					calls.push(options);
				}) as typeof scroller.scrollBy;
			}
			act(() => {
				host
					?.querySelector<HTMLElement>(
						"[data-testid=sidebar-more-unreads-down]"
					)
					?.click();
			});
			// Row 8 ends at 352; the viewport ends at 200, plus the 44px pill gap.
			expect(calls.map((call) => call.top)).toEqual([196]);
		} finally {
			view.restore();
		}
	});

	it("renders nothing when there are no unread rows", () => {
		const view = mount([]);
		try {
			expect(host?.querySelector("[data-testid^=sidebar-more-unreads]")).toBe(
				null
			);
		} finally {
			view.restore();
		}
	});
});
