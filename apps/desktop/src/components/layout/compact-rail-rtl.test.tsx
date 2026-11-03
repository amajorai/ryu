import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Root } from "react-dom/client";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// React DOM, Base UI and the workspace store read the DOM globals at import, so
// load them only after the globals above exist (static imports would hoist
// ahead of them).
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { DirectionProvider } = await import("@ryu/ui/components/direction.tsx");
const { SidebarProjectRail } = await import("./sidebar-project-rail.tsx");

const projects = [
	{ conversations: [], name: "ryu-private", path: "/w/ryu", sourceFolders: [] },
];

/** The declarations inside the first rule whose selector contains `selector`. */
function ruleBody(css: string, selector: string): string {
	const start = css.indexOf(selector);
	if (start < 0) {
		return "";
	}
	const open = css.indexOf("{", start);
	return css.slice(open + 1, css.indexOf("}", open));
}

let mounted: { host: HTMLElement; root: Root } | null = null;

afterEach(() => {
	if (mounted) {
		const { host, root } = mounted;
		act(() => root.unmount());
		host.remove();
		mounted = null;
	}
	document.documentElement.removeAttribute("dir");
});

async function hoverRailTooltip(direction: "ltr" | "rtl") {
	document.documentElement.dir = direction;
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	mounted = { host, root };
	await act(async () => {
		root.render(
			<DirectionProvider direction={direction}>
				<SidebarProjectRail projects={projects} />
			</DirectionProvider>
		);
	});
	const button = host.querySelector<HTMLElement>('[aria-label="ryu-private"]');
	if (!button) {
		throw new Error("The rail did not render the project button.");
	}
	await act(async () => {
		button.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
		button.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
		button.focus();
		await new Promise((resolve) => setTimeout(resolve, 900));
	});
	const popup = document.querySelector<HTMLElement>(
		'[data-slot="tooltip-content"]'
	);
	const positioner = popup?.parentElement;
	return {
		label: popup?.textContent,
		side: popup?.getAttribute("data-side"),
		transformOrigin: positioner?.style.getPropertyValue("--transform-origin"),
	};
}

describe("desktop shell under a right-to-left root", () => {
	test("the content clears the compact rail on its inline-start edge", () => {
		const css = readFileSync(new URL("./CompactRail.css", import.meta.url), {
			encoding: "utf8",
		});
		const inset = ruleBody(css, '[data-slot="sidebar-inset"]');
		expect(inset).toContain(
			"margin-inline-start: var(--ryu-compact-rail-width)"
		);
		expect(inset).not.toMatch(/margin-(left|right)/);
	});

	test("the live activity accent tints the thick inline-start border", () => {
		const css = readFileSync(
			new URL("../live/LiveActivitiesSection.css", import.meta.url),
			{ encoding: "utf8" }
		);
		const border = ruleBody(css, "[data-live-activity-border]");
		expect(border).toContain("border-inline-start-color");
		expect(border).not.toMatch(/border-(left|right)/);
	});

	test("rail tooltips open toward the content at the inline end", async () => {
		const rtl = await hoverRailTooltip("rtl");
		expect(rtl.label).toBe("ryu-private");
		expect(rtl.side).toBe("inline-end");
		// The popup grows out of its own right edge: it hangs to the left of
		// the rail, which is where the content sits in a right-to-left window.
		expect(rtl.transformOrigin).toStartWith("calc(100%");
	});

	test("left to right, the same tooltip hangs to the right of the rail", async () => {
		const ltr = await hoverRailTooltip("ltr");
		expect(ltr.label).toBe("ryu-private");
		expect(ltr.side).toBe("inline-end");
		expect(ltr.transformOrigin).toStartWith("-");
	});
});
