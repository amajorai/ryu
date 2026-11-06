import { describe, expect, test } from "bun:test";
import {
	compactRailNativeControls,
	topBarInsets,
	windowChromeLayout,
} from "./window-chrome-layout.ts";

type Direction = "ltr" | "rtl";
type Side = "left" | "right";

const SIDE_PREFIXES: Record<string, (dir: Direction) => Side> = {
	end: (dir) => (dir === "rtl" ? "left" : "right"),
	left: () => "left",
	right: () => "right",
	start: (dir) => (dir === "rtl" ? "right" : "left"),
};

/**
 * The physical side and value each inset/margin/padding utility resolves to
 * in a reading direction, after `rtl:` variants override the base classes,
 * the way the cascade applies them.
 */
function resolvePhysical(
	classes: string,
	dir: Direction
): Record<string, string> {
	const resolved: Record<string, string> = {};
	const tokens = classes.split(/\s+/).filter(Boolean);
	const base = tokens.filter((token) => !token.startsWith("rtl:"));
	const variants =
		dir === "rtl"
			? tokens
					.filter((token) => token.startsWith("rtl:"))
					.map((token) => token.slice(4))
			: [];
	for (const token of [...base, ...variants]) {
		const match = token.match(/^(m|p)?(s|e|l|r|start|end|left|right)-(.+)$/);
		if (!match) {
			continue;
		}
		const [, box = "", sideKey, value] = match;
		const key =
			{ e: "end", l: "left", r: "right", s: "start" }[sideKey] ?? sideKey;
		const side = SIDE_PREFIXES[key]?.(dir);
		if (side) {
			resolved[`${box || "inset"}-${side}`] = value;
		}
	}
	for (const [property, value] of Object.entries(resolved)) {
		if (value === "auto" || value === "0") {
			delete resolved[property];
		}
	}
	return resolved;
}

describe("shared shell window chrome", () => {
	test("reserves macOS traffic lights only in the native Desktop window", () => {
		const layout = windowChromeLayout({
			isMac: true,
			isMobile: false,
			nativeWindowChrome: true,
		});
		expect(resolvePhysical(layout.navClusterPosition, "ltr")).toEqual({
			"inset-left": "24",
		});
		expect(layout.navClusterReserve).toBe(
			"ryu-nav-cluster-reserve w-48 rtl:w-40"
		);
		expect(resolvePhysical(layout.pageActionsMargin, "ltr")).toEqual({
			"m-right": "2",
		});
	});

	test("keeps Webapp and extension navigation at the inline-start edge", () => {
		const layout = windowChromeLayout({
			isMac: true,
			isMobile: false,
			nativeWindowChrome: false,
		});
		expect(layout.navClusterReserve).toBe("ryu-nav-cluster-reserve w-40");
		for (const dir of ["ltr", "rtl"] as const) {
			const start = dir === "rtl" ? "right" : "left";
			const end = dir === "rtl" ? "left" : "right";
			expect(resolvePhysical(layout.navClusterPosition, dir)).toEqual({
				[`inset-${start}`]: "6",
			});
			expect(resolvePhysical(layout.pageActionsMargin, dir)).toEqual({
				[`m-${end}`]: "2",
			});
		}
	});

	test("reserves right-side caption buttons only in a native Desktop window", () => {
		const native = windowChromeLayout({
			isMac: false,
			isMobile: false,
			nativeWindowChrome: true,
		});
		expect(resolvePhysical(native.navClusterPosition, "ltr")).toEqual({
			"inset-left": "6",
		});
		expect(resolvePhysical(native.pageActionsMargin, "ltr")).toEqual({
			"m-right": "48",
		});
		const browser = windowChromeLayout({
			isMac: false,
			isMobile: false,
			nativeWindowChrome: false,
		});
		expect(resolvePhysical(browser.pageActionsMargin, "ltr")).toEqual({
			"m-right": "2",
		});
	});

	test("uses compact chrome on mobile without either desktop gutter", () => {
		const layout = windowChromeLayout({
			isMac: true,
			isMobile: true,
			nativeWindowChrome: true,
		});
		expect(layout.navClusterReserve).toBe("ryu-nav-cluster-reserve w-[4.5rem]");
		expect(resolvePhysical(layout.navClusterPosition, "ltr")).toEqual({
			"inset-left": "2",
		});
		expect(resolvePhysical(layout.navClusterPosition, "rtl")).toEqual({
			"inset-right": "2",
		});
	});
});

describe("native window controls stay physical under a right-to-left language", () => {
	test("macOS: right to left the cluster follows the sidebar and the actions clear the lights", () => {
		const layout = windowChromeLayout({
			isMac: true,
			isMobile: false,
			nativeWindowChrome: true,
		});
		// The traffic lights stay at the physical left, so the cluster leaves
		// them and moves to the inline start (right), over the sidebar.
		expect(resolvePhysical(layout.navClusterPosition, "rtl")).toEqual({
			"inset-right": "6",
		});
		// The title-bar actions are the row's end item, now at the physical
		// left, under the lights: they clear the lights there.
		expect(resolvePhysical(layout.pageActionsMargin, "rtl")).toEqual({
			"m-left": "24",
		});
	});

	test("Windows: right to left the caption buttons keep the top-right and the cluster the top-left", () => {
		const layout = windowChromeLayout({
			isMac: false,
			isMobile: false,
			nativeWindowChrome: true,
		});
		expect(resolvePhysical(layout.navClusterPosition, "rtl")).toEqual({
			"inset-left": "6",
		});
		// The actions now sit at the physical left beside the cluster, so they
		// clear it there and drop the dead caption-button margin on the right.
		expect(resolvePhysical(layout.pageActionsMargin, "rtl")).toEqual({
			"m-left": "40",
		});
		// The inline-start reserve, now on the right, holds the caption buttons.
		expect(layout.navClusterReserve).toContain("rtl:w-48");
	});

	test("top bars clear each platform's controls on the same physical side in both directions", () => {
		const mac = topBarInsets({ isMac: true, nativeWindowChrome: true });
		const windows = topBarInsets({ isMac: false, nativeWindowChrome: true });
		for (const dir of ["ltr", "rtl"] as const) {
			expect(resolvePhysical(mac, dir)).toEqual({ "p-left": "24" });
			expect(resolvePhysical(windows, dir)).toEqual({ "p-right": "48" });
		}
		expect(topBarInsets({ isMac: true, nativeWindowChrome: false })).toBe("");
	});

	test("names the controls a compact rail shares a corner with", () => {
		expect(
			compactRailNativeControls({ isMac: true, nativeWindowChrome: true })
		).toBe("traffic-lights");
		expect(
			compactRailNativeControls({ isMac: false, nativeWindowChrome: true })
		).toBe("caption-buttons");
		expect(
			compactRailNativeControls({ isMac: true, nativeWindowChrome: false })
		).toBe("");
	});
});
