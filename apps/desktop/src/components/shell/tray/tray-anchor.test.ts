import { describe, expect, test } from "bun:test";
import { sidebarTrayAnchor, trayPanelOrigin } from "./tray-anchor.ts";

const options = { gutter: 8, maxPanelWidth: 368, slotOffset: 6 };
const viewport = { innerHeight: 800, innerWidth: 1200 };

describe("sidebarTrayAnchor", () => {
	test("pins the box to the trigger's left edge under LTR", () => {
		const rect = { bottom: 760, left: 20, right: 48 };
		expect(sidebarTrayAnchor(rect, viewport, "ltr", options)).toEqual({
			bottom: 34,
			inlineStart: 14,
		});
	});

	test("pins the box to the trigger's right edge under RTL", () => {
		// The RTL sidebar sits on the right: the trigger is 20px from the right edge.
		const rect = { bottom: 760, left: 1152, right: 1180 };
		const anchor = sidebarTrayAnchor(rect, viewport, "rtl", options);
		expect(anchor).toEqual({ bottom: 34, inlineStart: 14 });
		// The open panel, laid out from the right edge, stays inside the window.
		const panelLeftEdge =
			viewport.innerWidth - anchor.inlineStart - options.maxPanelWidth;
		expect(panelLeftEdge).toBeGreaterThanOrEqual(options.gutter);
	});

	test("never starts the box off the window's start edge", () => {
		const ltr = { bottom: 760, left: 2, right: 30 };
		expect(sidebarTrayAnchor(ltr, viewport, "ltr", options).inlineStart).toBe(
			0
		);
		const rtl = { bottom: 760, left: 1170, right: 1198 };
		expect(sidebarTrayAnchor(rtl, viewport, "rtl", options).inlineStart).toBe(
			0
		);
	});

	test("keeps the open panel off the far edge on a wide sidebar", () => {
		// A trigger far from the start edge would grow the panel past the window.
		const narrow = { innerHeight: 800, innerWidth: 600 };
		const rtl = { bottom: 760, left: 100, right: 128 };
		const anchor = sidebarTrayAnchor(rtl, narrow, "rtl", options);
		expect(anchor.inlineStart).toBe(600 - 368 - 8);
		const ltr = { bottom: 760, left: 472, right: 500 };
		expect(sidebarTrayAnchor(ltr, narrow, "ltr", options).inlineStart).toBe(
			600 - 368 - 8
		);
	});

	test("narrows the panel to the viewport before clamping", () => {
		// 320px wide: the panel is 304px, so the start offset can be at most 8.
		const phone = { innerHeight: 640, innerWidth: 320 };
		const rect = { bottom: 600, left: 200, right: 228 };
		expect(sidebarTrayAnchor(rect, phone, "rtl", options)).toEqual({
			bottom: 34,
			inlineStart: 8,
		});
	});
});

describe("trayPanelOrigin", () => {
	test("grows a sidebar tray from the trigger's inline-start corner", () => {
		expect(trayPanelOrigin("sidebar", "ltr")).toBe("top left");
		expect(trayPanelOrigin("sidebar", "rtl")).toBe("top right");
	});

	test("keeps the menu-bar tray on the physical top-right controls", () => {
		expect(trayPanelOrigin("menubar", "ltr")).toBe("top right");
		expect(trayPanelOrigin("menubar", "rtl")).toBe("top right");
	});
});
