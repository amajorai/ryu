import { describe, expect, test } from "bun:test";
import { windowChromeLayout } from "./window-chrome-layout.ts";

describe("shared shell window chrome", () => {
	test("reserves macOS traffic lights only in the native Desktop window", () => {
		expect(
			windowChromeLayout({
				isMac: true,
				isMobile: false,
				nativeWindowChrome: true,
			})
		).toEqual({
			navClusterPosition: "top-4 left-24",
			navClusterReserve: "ryu-nav-cluster-reserve w-48",
			pageActionsMargin: "mr-2",
		});
	});

	test("keeps Mac Webapp and extension navigation edge-aligned", () => {
		expect(
			windowChromeLayout({
				isMac: true,
				isMobile: false,
				nativeWindowChrome: false,
			})
		).toEqual({
			navClusterPosition: "top-4 left-6",
			navClusterReserve: "ryu-nav-cluster-reserve w-40",
			pageActionsMargin: "mr-2",
		});
	});

	test("reserves right-side caption buttons only in a native Desktop window", () => {
		expect(
			windowChromeLayout({
				isMac: false,
				isMobile: false,
				nativeWindowChrome: true,
			})
		).toEqual({
			navClusterPosition: "top-4 left-6",
			navClusterReserve: "ryu-nav-cluster-reserve w-40",
			pageActionsMargin: "mr-48",
		});
		expect(
			windowChromeLayout({
				isMac: false,
				isMobile: false,
				nativeWindowChrome: false,
			}).pageActionsMargin
		).toBe("mr-2");
	});

	test("uses compact chrome on mobile without either desktop gutter", () => {
		expect(
			windowChromeLayout({
				isMac: true,
				isMobile: true,
				nativeWindowChrome: true,
			})
		).toEqual({
			navClusterPosition: "top-2 left-2",
			navClusterReserve: "ryu-nav-cluster-reserve w-[4.5rem]",
			pageActionsMargin: "mr-2",
		});
	});
});
