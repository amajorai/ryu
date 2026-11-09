import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register({ url: "http://localhost/" });
}

const { sidebarPreviewAnchor } = await import("./sidebar-preview-anchor.ts");

function rect(x: number, y: number, width: number, height: number): DOMRect {
	return DOMRect.fromRect({ height, width, x, y });
}

/** A 240px-wide sidebar boundary at x=800 (the right of the screen under RTL)
 * holding one 28px row at y=120. */
function sidebarRow(): HTMLElement {
	const boundary = document.createElement("nav");
	boundary.setAttribute("data-sidebar-preview-boundary", "");
	boundary.getBoundingClientRect = () => rect(800, 0, 240, 900);
	const row = document.createElement("a");
	row.getBoundingClientRect = () => rect(812, 120, 216, 28);
	boundary.append(row);
	document.body.append(boundary);
	return row;
}

afterEach(() => {
	document.body.innerHTML = "";
});

function boundaryAnchor(row: HTMLElement, dir: "ltr" | "rtl") {
	const anchor = sidebarPreviewAnchor(row, dir);
	if (!anchor || anchor instanceof HTMLElement) {
		throw new Error("expected a boundary anchor");
	}
	return anchor;
}

test("rtl: the preview anchors to the sidebar's left edge, outside the sidebar", () => {
	const row = sidebarRow();
	const anchor = boundaryAnchor(row, "rtl");
	expect(anchor.contextElement).toBe(row);
	const box = anchor.getBoundingClientRect();
	expect(box.x).toBe(800);
	expect(box.y).toBe(120);
	expect(box.width).toBe(0);
	expect(box.height).toBe(28);
});

test("ltr: the preview anchors to the sidebar's right edge", () => {
	expect(boundaryAnchor(sidebarRow(), "ltr").getBoundingClientRect().x).toBe(
		1040
	);
});

test("a row outside any preview boundary anchors to itself", () => {
	const row = document.createElement("a");
	document.body.append(row);
	expect(sidebarPreviewAnchor(row, "rtl")).toBe(row);
	expect(sidebarPreviewAnchor(null, "rtl")).toBeNull();
});
