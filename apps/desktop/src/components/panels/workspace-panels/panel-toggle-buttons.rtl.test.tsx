import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const { DirectionProvider } = await import("@ryu/ui/components/direction.tsx");
const { DIRECTIONAL_ICON_CLASS } = await import(
	"@ryu/ui/components/directional-icon.tsx"
);
const { PanelToggleButtons } = await import("./panel-toggle-buttons.tsx");
const { IconSidebarClosed, IconSidebarOpen } = await import(
	"../../icons/SidebarToggleIcon.tsx"
);

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
	host = document.createElement("div");
	host.setAttribute("dir", "rtl");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});

function renderToggles(rightOpen: boolean) {
	act(() =>
		root?.render(
			<DirectionProvider direction="rtl">
				<PanelToggleButtons
					bottomOpen={false}
					onBottomToggle={() => undefined}
					onRightToggle={() => undefined}
					rightOpen={rightOpen}
				/>
			</DirectionProvider>
		)
	);
}

function sidePanelButton(): HTMLButtonElement {
	const button = host?.querySelector<HTMLButtonElement>(
		'button[aria-pressed][aria-label*="side panel"]'
	);
	if (!button) {
		throw new Error("side panel toggle not rendered");
	}
	return button;
}

describe("side panel toggle under dir=rtl", () => {
	for (const open of [true, false]) {
		test(`${open ? "open" : "closed"}: names no physical side and mirrors its glyph`, () => {
			renderToggles(open);
			const button = sidePanelButton();
			const label = button.getAttribute("aria-label") ?? "";
			expect(label).toBe(open ? "Hide side panel" : "Show side panel");
			expect(label.toLowerCase()).not.toContain("right");
			expect(label.toLowerCase()).not.toContain("left");
			const glyph = button.querySelector("svg");
			expect(glyph?.getAttribute("class")?.split(/\s+/)).toContain(
				DIRECTIONAL_ICON_CLASS
			);
		});
	}

	test("the bottom panel glyph stays unmirrored", () => {
		renderToggles(false);
		const bottom = host?.querySelector(
			'button[aria-label="Show bottom panel"]'
		);
		expect(bottom?.querySelector("svg")?.getAttribute("class")).not.toContain(
			DIRECTIONAL_ICON_CLASS
		);
	});
});

describe("sidebar toggle glyphs", () => {
	test("mirror under RTL and keep the caller's classes", () => {
		act(() =>
			root?.render(
				<>
					<IconSidebarOpen className="size-4" data-testid="open" />
					<IconSidebarClosed className="size-4" data-testid="closed" />
				</>
			)
		);
		for (const id of ["open", "closed"]) {
			const classes =
				host
					?.querySelector(`[data-testid="${id}"]`)
					?.getAttribute("class")
					?.split(/\s+/) ?? [];
			expect(classes).toContain(DIRECTIONAL_ICON_CLASS);
			expect(classes).toContain("size-4");
		}
	});
});
