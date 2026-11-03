import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// A Sheet's side is physical (it pins to that window edge), so its divider
// must sit on the opposite physical edge, facing the page, in either reading
// direction. A logical border-s used to land on the window edge under RTL.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { Sheet, SheetContent, SheetTitle } = await import("./sheet.tsx");
const { DirectionProvider } = await import("./direction.tsx");

let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	container?.remove();
	root = undefined;
	container = undefined;
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function sheetClasses(
	direction: "ltr" | "rtl",
	side: "left" | "right"
): Promise<{ classes: string[]; dir: string | null; side: string | null }> {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<DirectionProvider direction={direction}>
				<Sheet open>
					<SheetContent side={side}>
						<SheetTitle>Details</SheetTitle>
					</SheetContent>
				</Sheet>
			</DirectionProvider>
		);
	});
	const popup = document.querySelector('[data-slot="sheet-content"]');
	if (!popup) {
		throw new Error("Sheet content did not render");
	}
	return {
		classes: (popup.getAttribute("class") ?? "").split(/\s+/u),
		dir: popup.getAttribute("dir"),
		side: popup.getAttribute("data-side"),
	};
}

describe("Sheet divider", () => {
	for (const direction of ["ltr", "rtl"] as const) {
		test(`faces the page from a right sheet (${direction})`, async () => {
			const { classes, dir, side } = await sheetClasses(direction, "right");
			expect(dir).toBe(direction);
			expect(side).toBe("right");
			expect(classes).toContain("data-[side=right]:border-l");
			expect(classes).not.toContain("data-[side=right]:border-s");
		});

		test(`faces the page from a left sheet (${direction})`, async () => {
			const { classes, dir, side } = await sheetClasses(direction, "left");
			expect(dir).toBe(direction);
			expect(side).toBe("left");
			expect(classes).toContain("data-[side=left]:border-r");
			expect(classes).not.toContain("data-[side=left]:border-e");
		});
	}
});
