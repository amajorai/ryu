// The docked Ask Ryu rail under both reading directions. The main navigation
// sidebar sits at the inline start (the physical RIGHT under RTL), so the rail
// must be an inline-END dock: physical right in LTR, physical left in RTL, and
// never stacked over the navigation. Layout reserves the matching inline-end
// padding so the canvas narrows from the rail's side.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const { RyuAssistantWidgetFrame } = await import(
	"@ryu/assistant-widget/surface"
);
const { assistantDockFrameClassName } = await import(
	"./assistant-dock-frame.ts"
);

type Direction = "ltr" | "rtl";

const VARIANTS = [
	{ floatingChrome: true, titleBarClearsContent: true },
	{ floatingChrome: true, titleBarClearsContent: false },
	{ floatingChrome: false, titleBarClearsContent: true },
	{ floatingChrome: false, titleBarClearsContent: false },
] as const;

// Physical horizontal placement utilities (with or without a variant prefix).
const PHYSICAL_INSET = /(^|:)-?(left|right)-/;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});

function renderDockedFrame(
	direction: Direction,
	variant: (typeof VARIANTS)[number]
): HTMLElement {
	host = document.createElement("div");
	host.setAttribute("dir", direction);
	document.body.append(host);
	root = createRoot(host);
	act(() =>
		root?.render(
			<RyuAssistantWidgetFrame
				ariaLabel="Ask Ryu assistant"
				className={assistantDockFrameClassName(variant)}
				placement="docked"
			>
				<p>body</p>
			</RyuAssistantWidgetFrame>
		)
	);
	const frame = host.querySelector<HTMLElement>("[data-placement=docked]");
	if (!frame) {
		throw new Error("docked frame did not render");
	}
	return frame;
}

describe("docked Ask Ryu rail", () => {
	for (const direction of ["ltr", "rtl"] as const) {
		for (const variant of VARIANTS) {
			const label = `${direction} floating=${variant.floatingChrome} titlebar=${variant.titleBarClearsContent}`;
			test(`resolves to the inline end (${label})`, () => {
				const frame = renderDockedFrame(direction, variant);
				const classes = [...frame.classList];
				expect(frame.closest("[dir]")?.getAttribute("dir")).toBe(direction);
				expect(classes.some((name) => /^end-\d/.test(name))).toBe(true);
				// From md up the rail is one column at the end, not a full span.
				expect(classes).toContain("md:start-auto");
				expect(classes).toContain("md:w-[380px]");
				expect(classes.filter((name) => PHYSICAL_INSET.test(name))).toEqual([]);
			});
		}
	}

	test("keeps the floating card inset from the inline end and the flush rail on it", () => {
		expect(
			assistantDockFrameClassName({
				floatingChrome: true,
				titleBarClearsContent: true,
			}).split(" ")
		).toEqual(expect.arrayContaining(["end-2", "start-2", "rounded-3xl"]));
		expect(
			assistantDockFrameClassName({
				floatingChrome: false,
				titleBarClearsContent: false,
			}).split(" ")
		).toEqual(expect.arrayContaining(["end-0", "start-0", "inset-y-0"]));
	});
});

describe("assistant reserve", () => {
	const css = readFileSync(
		new URL("../layout/Layout.module.css", import.meta.url),
		"utf8"
	);
	const rule = css.match(/#assistantReserve\s*\{([^}]*)\}/)?.[1] ?? "";

	test("pads the inline end, the same side as the rail", () => {
		expect(rule).toContain(
			"padding-inline-end: var(--desktop-inline7-padding-End)"
		);
		expect(rule).not.toMatch(/padding-(left|right)/);
	});

	test("Layout sets the inline-end reserve variable for the docked rail", async () => {
		const { layoutCssVariables } = await import(
			"../shell/layout/shell-overlays.tsx"
		);
		const { cssVariables5 } = layoutCssVariables({
			assistantDockReserve: 388,
			floatOpen: false,
			osProduct: false,
			sidebarWidth: 256,
			titleBarClearsContent: true,
		});
		expect(cssVariables5).toEqual({ "--desktop-inline7-padding-End": "388px" });
	}, 120_000);
});
