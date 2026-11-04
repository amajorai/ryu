import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Logical sheet sides follow the reading direction: a detail drawer docked at
// the inline end opens from the physical left under RTL, matching the rest of
// the shell's end-side panels. Physical sides stay pinned to their edge.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { Sheet, SheetContent, SheetTitle } = await import("./sheet.tsx");
const { DirectionProvider } = await import("./direction.tsx");
const { resolveSheetSide } = await import("./sheet-side.ts");
type SheetSide = import("./sheet-side.ts").SheetSide;

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

async function renderedSide(
	direction: "ltr" | "rtl",
	side?: SheetSide
): Promise<string | null> {
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
	return popup.getAttribute("data-side");
}

describe("Sheet logical sides", () => {
	test("inline-end resolves to the left edge under RTL", async () => {
		expect(await renderedSide("rtl", "inline-end")).toBe("left");
	});

	test("inline-end resolves to the right edge under LTR", async () => {
		expect(await renderedSide("ltr", "inline-end")).toBe("right");
	});

	test("the default side is the inline end", async () => {
		expect(await renderedSide("ltr")).toBe("right");
		await act(async () => {
			root?.unmount();
		});
		container?.remove();
		expect(await renderedSide("rtl")).toBe("left");
	});

	test("inline-start resolves to the right edge under RTL", async () => {
		expect(await renderedSide("rtl", "inline-start")).toBe("right");
	});

	test("physical sides stay pinned in either direction", () => {
		for (const direction of ["ltr", "rtl"]) {
			expect(resolveSheetSide("right", direction)).toBe("right");
			expect(resolveSheetSide("left", direction)).toBe("left");
			expect(resolveSheetSide("top", direction)).toBe("top");
			expect(resolveSheetSide("bottom", direction)).toBe("bottom");
		}
		expect(resolveSheetSide("inline-start", undefined)).toBe("left");
	});
});
