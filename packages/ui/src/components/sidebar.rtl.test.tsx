import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DirectionProvider } from "./direction.tsx";
import {
	physicalSheetSide,
	Sidebar,
	SidebarInset,
	SidebarProvider,
	SidebarRail,
	SidebarTrigger,
} from "./sidebar.tsx";

function classesOf(html: string, slot: string): string[] {
	const tag = html.match(new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`))?.[0];
	if (!tag) {
		throw new Error(`no ${slot} in markup`);
	}
	return (tag.match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
}

function shell(direction: "ltr" | "rtl", side?: "left" | "right"): string {
	const tree: ReactElement = (
		<DirectionProvider direction={direction}>
			<div dir={direction}>
				<SidebarProvider>
					<Sidebar side={side}>
						<SidebarRail />
						<SidebarTrigger />
					</Sidebar>
					<SidebarInset />
				</SidebarProvider>
			</div>
		</DirectionProvider>
	);
	return renderToStaticMarkup(tree);
}

const PHYSICAL_INLINE =
	/^(?:.*:)?-?(?:left|right)-|(?:^|:)border-[lr]$|(?:^|:)m[lr]-/;

describe("Sidebar in a right-to-left layout", () => {
	for (const direction of ["ltr", "rtl"] as const) {
		test(`${direction}: the fixed panel is pinned with logical insets that match the in-flow gap`, () => {
			const container = classesOf(shell(direction), "sidebar-container");
			expect(container).toContain("data-[side=left]:start-0");
			expect(container).toContain("data-[side=right]:end-0");
			expect(container).toContain("group-data-[side=left]:border-e");
			expect(container).toContain("group-data-[side=right]:border-s");
			expect(container.filter((name) => PHYSICAL_INLINE.test(name))).toEqual(
				[]
			);
		});
	}

	test("off-canvas keeps the LTR slide and adds an RTL slide toward the physical right", () => {
		const container = classesOf(shell("rtl"), "sidebar-container");
		expect(container).toContain(
			"data-[side=left]:group-data-[collapsible=offcanvas]:-translate-x-full"
		);
		expect(container).toContain(
			"rtl:data-[side=left]:group-data-[collapsible=offcanvas]:translate-x-full"
		);
		expect(container).toContain(
			"rtl:data-[side=right]:group-data-[collapsible=offcanvas]:-translate-x-full"
		);
	});

	test("the rail straddles the inner edge with logical offsets in both directions", () => {
		const rail = classesOf(shell("rtl"), "sidebar-rail");
		expect(rail).toContain("group-data-[side=left]:-end-4");
		expect(rail).toContain("group-data-[side=right]:start-0");
		expect(rail).toContain("ltr:-translate-x-1/2");
		expect(rail).toContain("rtl:translate-x-1/2");
		expect(rail).toContain(
			"group-data-[collapsible=offcanvas]:after:start-full"
		);
		expect(rail).toContain("rtl:in-data-[side=left]:cursor-e-resize");
		expect(rail.filter((name) => PHYSICAL_INLINE.test(name))).toEqual([]);
	});

	test("the inset variant margin and the trigger glyph follow the reading direction", () => {
		const html = shell("rtl");
		const inset = classesOf(html, "sidebar-inset");
		expect(inset).toContain("md:peer-data-[variant=inset]:ms-0");
		expect(inset.filter((name) => PHYSICAL_INLINE.test(name))).toEqual([]);
		expect(html).toContain("rtl:-scale-x-100");
	});

	test("the collapsible=none branch is untouched", () => {
		const html = renderToStaticMarkup(
			<DirectionProvider direction="rtl">
				<SidebarProvider>
					<Sidebar collapsible="none" />
				</SidebarProvider>
			</DirectionProvider>
		);
		expect(classesOf(html, "sidebar")).toEqual([
			"flex",
			"h-full",
			"w-(--sidebar-width)",
			"flex-col",
			"bg-sidebar",
			"text-sidebar-foreground",
		]);
	});

	test("the mobile sheet opens from the inline start", () => {
		expect(physicalSheetSide("left", "ltr")).toBe("left");
		expect(physicalSheetSide("right", "ltr")).toBe("right");
		expect(physicalSheetSide("left", undefined)).toBe("left");
		expect(physicalSheetSide("left", "rtl")).toBe("right");
		expect(physicalSheetSide("right", "rtl")).toBe("left");
	});
});
