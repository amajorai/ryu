import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode, useState } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const { DirectionProvider } = await import("@ryu/ui/components/direction.tsx");
const { RightDockPanel, renderWorkspaceDockLayout } = await import(
	"./workspace-dock-layout.tsx"
);
const { useResizeHandle } = await import("./use-resize-handle.ts");

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});

function render(node: ReactNode) {
	act(() => root?.render(node));
}

function DockLayout({ dir }: { dir: "ltr" | "rtl" }) {
	return (
		<DirectionProvider direction={dir}>
			{renderWorkspaceDockLayout({
				bottomCard: () => null,
				bottomOpen: false,
				bottomResizeHandle: null,
				bottomResizing: false,
				children: <p>chat</p>,
				closeBottom: () => undefined,
				closeRight: () => undefined,
				containerRef: { current: null },
				dockTop: "top-12",
				effectiveBottomHeight: 200,
				floatingChrome: false,
				hideRightPeek: () => undefined,
				isMobile: false,
				pinnedColumnWidth: 288,
				pinnedDocked: true,
				pinnedFloating: false,
				renderPinnedSummary: () => <p>pinned</p>,
				rightCard: () => <p>dock</p>,
				rightDockWidth: 0,
				rightOpen: false,
				rightPanelWidth: 360,
				rightResizeHandle: null,
				rightResizing: false,
				rightVisible: false,
				showRightPeek: () => undefined,
				titleBarClearsContent: false,
			})}
		</DirectionProvider>
	);
}

function dockElement(): HTMLElement {
	const dock = host?.querySelector<HTMLElement>(
		'[data-testid="workspace-right-dock"]'
	);
	if (!dock) {
		throw new Error("dock not rendered");
	}
	return dock;
}

describe("workspace dock under RTL", () => {
	test("pins the dock and its hover strip to the inline end", () => {
		render(<DockLayout dir="rtl" />);
		const dock = dockElement();
		expect(dock.className).toContain("end-0");
		expect(dock.className).not.toContain("right-0");
		const html = host?.innerHTML ?? "";
		expect(html).not.toContain("right-0");
		expect(html).toContain("border-s");
		expect(html).not.toContain("border-l ");
	});

	test("hides the dock past the physical left under RTL", () => {
		render(<DockLayout dir="rtl" />);
		expect(dockElement().style.getPropertyValue("--workspace-transform")).toBe(
			"translateX(-100%)"
		);
	});

	test("hides the dock past the physical right under LTR", () => {
		render(<DockLayout dir="ltr" />);
		expect(dockElement().style.getPropertyValue("--workspace-transform")).toBe(
			"translateX(100%)"
		);
	});

	test("a visible dock is not offset in either direction", () => {
		render(
			<DirectionProvider direction="rtl">
				<RightDockPanel
					className=""
					onMouseEnter={undefined}
					onMouseLeave={undefined}
					resizing={false}
					visible
					width={300}
				>
					<p>dock</p>
				</RightDockPanel>
			</DirectionProvider>
		);
		expect(dockElement().style.getPropertyValue("--workspace-transform")).toBe(
			"translateX(0)"
		);
	});
});

function ResizeProbe() {
	const [width, setWidth] = useState(300);
	const { onMouseDown } = useResizeHandle("horizontal", setWidth);
	return (
		<button
			data-width={width}
			onMouseDown={(event) => onMouseDown(event, width)}
			type="button"
		>
			resize
		</button>
	);
}

describe("dock resize under RTL", () => {
	test("dragging to the physical right widens the RTL dock", () => {
		render(
			<DirectionProvider direction="rtl">
				<ResizeProbe />
			</DirectionProvider>
		);
		const button = host?.querySelector("button");
		if (!button) {
			throw new Error("probe not rendered");
		}
		act(() => {
			button.dispatchEvent(
				new MouseEvent("mousedown", { bubbles: true, clientX: 100 })
			);
		});
		act(() => {
			document.dispatchEvent(new MouseEvent("mousemove", { clientX: 160 }));
		});
		act(() => {
			document.dispatchEvent(new MouseEvent("mouseup"));
		});
		expect(button.dataset.width).toBe("360");
	});

	test("dragging to the physical left widens the LTR dock", () => {
		render(
			<DirectionProvider direction="ltr">
				<ResizeProbe />
			</DirectionProvider>
		);
		const button = host?.querySelector("button");
		if (!button) {
			throw new Error("probe not rendered");
		}
		act(() => {
			button.dispatchEvent(
				new MouseEvent("mousedown", { bubbles: true, clientX: 500 })
			);
		});
		act(() => {
			document.dispatchEvent(new MouseEvent("mousemove", { clientX: 440 }));
		});
		act(() => {
			document.dispatchEvent(new MouseEvent("mouseup"));
		});
		expect(button.dataset.width).toBe("360");
	});
});
