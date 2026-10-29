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

test("the Products sheet mirrors the desktop menu: one open section, summaries, and both footer links", async () => {
	const { focusableElements } = await import("./mobile-nav-sheet-data.ts");
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () => {
			root.render(<MobileNav />);
		});
		const products = container.querySelector<HTMLButtonElement>(
			'button[aria-controls="mobile-nav-sheet"]'
		);
		await act(async () => {
			products?.click();
		});
		await settle();

		const sheet = document.getElementById("mobile-nav-sheet");
		if (!sheet) {
			throw new Error("The Products sheet did not open");
		}
		const sections = Array.from(
			sheet.querySelectorAll<HTMLElement>("[data-sheet-group]")
		);
		expect(sections.map((section) => section.dataset.sheetGroup)).toEqual([
			"Workspaces",
			"Build",
			"Platform",
			"Agent APIs",
		]);
		// Every section has a disclosure button; only the first starts open.
		const triggers = sections.map((section) =>
			section.querySelector<HTMLButtonElement>("button[aria-expanded]")
		);
		expect(
			triggers.map((trigger) => trigger?.getAttribute("aria-expanded"))
		).toEqual(["true", "false", "false", "false"]);
		const openLinks = Array.from(
			sections[0]?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? []
		);
		expect(openLinks.map((link) => link.getAttribute("href"))).toEqual([
			"/bot",
			"/agent",
			"/products/desktop",
		]);
		// The name sits over its one-line summary.
		expect(openLinks[0]?.textContent).toContain("Bot");
		expect(openLinks[0]?.textContent).toContain(
			"Managed AI without setting up a stack."
		);

		const footer = sheet.querySelector(
			'[data-testid="mobile-nav-sheet-footer"]'
		);
		expect(
			Array.from(footer?.querySelectorAll("a") ?? [], (link) =>
				link.getAttribute("href")
			)
		).toEqual(["/products", "/platform"]);

		// The focus trap skips collapsed sections: Tab from the last control
		// (the footer link) wraps to the first.
		const focusable = focusableElements(sheet);
		expect(
			focusable.some((element) =>
				sections
					.slice(1)
					.some((section) =>
						section
							.querySelector('[data-slot="accordion-content"]')
							?.contains(element)
					)
			)
		).toBe(false);
		expect(focusable.at(-1)?.getAttribute("href")).toBe("/platform");
		await act(async () => {
			focusable.at(-1)?.focus();
			document.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Tab" })
			);
		});
		expect(document.activeElement).toBe(focusable[0] ?? null);

		// Opening another section closes the first, so the sheet stays short.
		await act(async () => {
			triggers[1]?.click();
		});
		await settle();
		expect(triggers[0]?.getAttribute("aria-expanded")).toBe("false");
		expect(triggers[1]?.getAttribute("aria-expanded")).toBe("true");
	} finally {
		act(() => root.unmount());
		container.remove();
	}
});

test("the Resources sheet opens the Docs entry in a new tab, as the desktop Resources menu does", async () => {
	const { DOCS_URL } = await import("./data/resources.tsx");
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () => {
			root.render(<MobileNav />);
		});
		const resources = Array.from(
			container.querySelectorAll<HTMLButtonElement>(
				'button[aria-controls="mobile-nav-sheet"]'
			)
		).find((button) => button.textContent?.includes("Resources"));
		await act(async () => {
			resources?.click();
		});
		await settle();

		const sheet = document.getElementById("mobile-nav-sheet");
		const learn = sheet?.querySelector<HTMLElement>(
			'[data-sheet-group="Learn"]'
		);
		await act(async () => {
			learn?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();
		});
		await settle();

		const docs = learn?.querySelector<HTMLAnchorElement>(
			`a[href="${DOCS_URL}"]`
		);
		expect(docs?.textContent).toContain("Docs");
		expect(docs?.getAttribute("target")).toBe("_blank");
		expect(docs?.getAttribute("rel")).toBe("noopener noreferrer");
	} finally {
		act(() => root.unmount());
		container.remove();
	}
});
