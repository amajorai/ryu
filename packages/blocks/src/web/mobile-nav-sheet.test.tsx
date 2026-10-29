import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register({ url: "https://ryu.test/" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

mock.module("next/navigation", () => ({
	usePathname: () => "/",
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MobileNav } = await import("./mobile-nav.tsx");

afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

/** Let the lazily imported sheet module resolve and React commit it. */
async function settle() {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		await act(async () => {
			await new Promise<void>((resolve) => queueMicrotask(resolve));
		});
		if (document.getElementById("mobile-nav-sheet")) {
			return;
		}
	}
}

test("the sheet loads on first open, takes focus, and hands it back on Escape", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () => {
			root.render(<MobileNav />);
		});
		// Nothing of the sheet is mounted until a visitor reaches for it.
		expect(document.getElementById("mobile-nav-sheet")).toBeNull();

		const products = container.querySelector<HTMLButtonElement>(
			'button[aria-controls="mobile-nav-sheet"]'
		);
		expect(products?.textContent).toContain("Products");
		await act(async () => {
			products?.focus();
			products?.click();
		});
		await settle();

		const sheet = document.getElementById("mobile-nav-sheet");
		expect(sheet?.getAttribute("role")).toBe("dialog");
		expect(products?.getAttribute("aria-expanded")).toBe("true");
		expect(sheet?.contains(document.activeElement)).toBe(true);

		await act(async () => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
		});
		expect(products?.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(products);
	} finally {
		act(() => root.unmount());
		container.remove();
	}
});
