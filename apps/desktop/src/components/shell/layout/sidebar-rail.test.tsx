// The docked sidebar rail under both reading directions. The shared <Sidebar>
// sits at the inline start, which is the physical RIGHT under RTL: dragging its
// edge left must widen it there, and the collapsed hover peek must sit on (and
// slide in from) that same edge.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// The real panel pulls in the whole sidebar tree; placement is all under test.
mock.module("@/src/components/layout/AppSidebar.tsx", () => ({
	SidebarPanelContent: () => <nav data-testid="panel" />,
}));

const { createRoot } = await import("react-dom/client");
const { DirectionProvider } = await import("@ryu/ui/components/direction.tsx");
const { FloatingSidebarPeek, sidebarRailAxis, useSidebarRailResize } =
	await import("./sidebar-rail.tsx");
const { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } = await import(
	"./layout-constants.ts"
);

type Direction = "ltr" | "rtl";

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});

function mount(direction: Direction, node: ReactNode) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() =>
		root?.render(
			<DirectionProvider direction={direction}>{node}</DirectionProvider>
		)
	);
	return host;
}

function Rail({ onWidth }: { onWidth: (width: number) => void }) {
	const { handleRailPointerDown } = useSidebarRailResize(
		260,
		onWidth,
		() => undefined
	);
	return <div data-testid="rail" onPointerDown={handleRailPointerDown} />;
}

function pointer(type: string, clientX: number, timeStamp: number) {
	const event = new window.PointerEvent(type, {
		bubbles: true,
		clientX,
		pointerId: 1,
	});
	Object.defineProperty(event, "timeStamp", { value: timeStamp });
	return event;
}

/** Drag the rail 40px toward the physical LEFT, slowly enough not to flick. */
function dragLeft(direction: Direction): number[] {
	const widths: number[] = [];
	const el = mount(direction, <Rail onWidth={(w) => widths.push(w)} />);
	const rail = el.querySelector('[data-testid="rail"]');
	if (!rail) {
		throw new Error("rail not rendered");
	}
	act(() => {
		rail.dispatchEvent(pointer("pointerdown", 500, 0));
		document.dispatchEvent(pointer("pointermove", 480, 400));
		document.dispatchEvent(pointer("pointermove", 460, 800));
		document.dispatchEvent(pointer("pointerup", 460, 1200));
	});
	return widths;
}

describe("sidebarRailAxis", () => {
	test("keeps clientX in LTR and negates it in RTL", () => {
		expect(sidebarRailAxis(120, "ltr")).toBe(120);
		expect(sidebarRailAxis(120, "rtl")).toBe(-120);
	});
});

describe("useSidebarRailResize", () => {
	test("dragging left narrows the start-side sidebar in LTR", () => {
		const widths = dragLeft("ltr");
		expect(widths.at(-1)).toBe(Math.max(SIDEBAR_MIN_WIDTH, 220));
	});

	test("dragging left widens the right-hand sidebar under dir=rtl", () => {
		const widths = dragLeft("rtl");
		expect(widths.at(-1)).toBe(Math.min(SIDEBAR_MAX_WIDTH, 300));
		expect(widths.every((w) => w >= 260)).toBe(true);
	});
});

describe("FloatingSidebarPeek placement", () => {
	function renderPeek(direction: Direction) {
		const el = mount(
			direction,
			<FloatingSidebarPeek
				cssVariables3={{}}
				cssVariables4={{ "--desktop-inline4-offset": "calc(100% + 12px)" }}
				onRailPointerDown={() => undefined}
				panelProps={{} as never}
				scheduleHide={() => undefined}
				showFloat={() => undefined}
			/>
		);
		const container = el.querySelector('[data-testid="sidebar-peek"]');
		const panel = container?.querySelector("[data-sidebar-preview-boundary]");
		const [handle] = panel?.querySelectorAll(".cursor-col-resize") ?? [];
		const hotZone = container?.lastElementChild;
		return {
			container: container?.className ?? "",
			handle: handle?.className ?? "",
			hotZone: hotZone?.className ?? "",
			panel: panel?.className ?? "",
			sign: (panel as HTMLElement | null)?.style.getPropertyValue(
				"--desktop-inline4-sign"
			),
		};
	}

	test("anchors every layer to logical edges, never physical ones", () => {
		const placement = renderPeek("rtl");
		for (const cls of Object.values(placement)) {
			expect(cls).not.toMatch(/\b(left|right)-\d/);
		}
		expect(placement.container).toContain("start-0");
		expect(placement.panel).toContain("start-2");
		expect(placement.handle).toContain("end-0");
		expect(placement.hotZone).toContain("start-0");
	});

	test("slides in from the physical left in LTR and the right in RTL", () => {
		expect(renderPeek("ltr").sign).toBe("-1");
		expect(renderPeek("rtl").sign).toBe("1");
	});
});
