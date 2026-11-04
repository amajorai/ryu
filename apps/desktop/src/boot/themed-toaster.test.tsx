import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { DirectionProvider } = await import("@ryu/ui/components/direction.tsx");
const { toast } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { ThemedToaster, toasterPosition } = await import("./themed-toaster.tsx");

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
	await act(async () => {
		sileo.clear();
		root?.unmount();
		await Promise.resolve();
	});
	host?.remove();
	root = null;
	host = null;
});

async function mountedPositions(direction: "ltr" | "rtl"): Promise<string[]> {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<DirectionProvider direction={direction}>
				<ThemedToaster />
			</DirectionProvider>
		);
		await Promise.resolve();
	});
	await act(async () => {
		toast.success("Saved", { description: "Your changes are stored." });
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	const positions = [
		...document.querySelectorAll("[data-sileo-viewport][data-position]"),
	].map((viewport) => viewport.getAttribute("data-position") ?? "");
	return positions;
}

describe("ThemedToaster placement", () => {
	test("maps the reading direction to the inline-end corner", () => {
		expect(toasterPosition("ltr")).toBe("bottom-right");
		expect(toasterPosition(undefined)).toBe("bottom-right");
		expect(toasterPosition("rtl")).toBe("bottom-left");
	});

	test("shows toasts bottom-left under a right-to-left direction", async () => {
		expect(await mountedPositions("rtl")).toEqual(["bottom-left"]);
	});

	test("shows toasts bottom-right under a left-to-right direction", async () => {
		expect(await mountedPositions("ltr")).toEqual(["bottom-right"]);
	});
});
