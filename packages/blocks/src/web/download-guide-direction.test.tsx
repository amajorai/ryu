import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register the DOM before React and Base UI load (see download-menu.test.tsx).
const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register({ url: "https://ryu.test/" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { DownloadGuidePanel } = await import("./download-guide-panel.tsx");
const { browserDownloadHint } = await import("./download-guide.ts");
const { browserChromeDirection, languageDirection } = await import(
	"./download-guide-direction.ts"
);

type Root = import("react-dom/client").Root;
const roots: Root[] = [];

function useBrowserLanguage(language: string) {
	Object.defineProperty(navigator, "language", {
		configurable: true,
		value: language,
	});
}

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	Reflect.deleteProperty(navigator, "language");
	document.body.replaceChildren();
});

afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

const pointer = () =>
	document.querySelector('[data-testid="download-guide-pointer"]');
const toolbar = () =>
	document.querySelector('[data-testid="download-guide-toolbar"]');

async function renderPanel() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<DownloadGuidePanel
				browser="chrome"
				detail={{
					os: "windows",
					arch: "intel",
					assetName: "Ryu_x64-setup.exe",
					href: "https://example.test/Ryu_x64-setup.exe",
				}}
				onOpenChange={() => undefined}
				open
			/>
		);
	});
	const deadline = Date.now() + 15_000;
	while (pointer() === null && Date.now() < deadline) {
		await act(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		});
	}
}

describe("languageDirection", () => {
	test("reads RTL languages and scripts from a BCP 47 tag", () => {
		for (const tag of ["ar", "ar-EG", "he-IL", "fa", "ur-PK", "pa-Arab"]) {
			expect(languageDirection(tag)).toBe("rtl");
		}
		for (const tag of [
			"en-US",
			"de-DE",
			"ja",
			"fr",
			"zh-Hans",
			"ar-Latn",
			"",
			undefined,
		]) {
			expect(languageDirection(tag)).toBe("ltr");
		}
	});

	test("browserChromeDirection follows navigator.language", () => {
		useBrowserLanguage("ar-SA");
		expect(browserChromeDirection()).toBe("rtl");
		useBrowserLanguage("en-GB");
		expect(browserChromeDirection()).toBe("ltr");
	});
});

describe("download guide under an RTL browser UI", () => {
	test("the corner pointer and toolbar mock mirror to the top-left", async () => {
		useBrowserLanguage("ar");
		await renderPanel();
		const arrow = pointer();
		expect(arrow?.getAttribute("dir")).toBe("rtl");
		// A full-width strip that packs to its own inline end: the left under
		// dir="rtl", whatever the viewport's (Ryu's) direction is.
		expect(arrow?.className).toContain("justify-end");
		expect(arrow?.className).toContain("pe-8");
		expect(arrow?.className).not.toMatch(/\b(?:end|right|left)-\d/);
		expect(toolbar()?.getAttribute("dir")).toBe("rtl");
	});

	test("an RTL Ryu page over an LTR browser keeps the chrome LTR", async () => {
		document.documentElement.setAttribute("dir", "rtl");
		try {
			useBrowserLanguage("de-DE");
			await renderPanel();
			expect(pointer()?.getAttribute("dir")).toBe("ltr");
			expect(toolbar()?.getAttribute("dir")).toBe("ltr");
			// Glyph flips read the nearest `dir` (`:dir(rtl)`), not a bare
			// `rtl:` that also matches under the RTL <html>.
			const flipped = document.querySelectorAll(
				'[data-testid="download-guide-toolbar"] svg[class*="scale-x"]'
			);
			expect(flipped.length).toBeGreaterThan(0);
			for (const glyph of flipped) {
				expect(glyph.getAttribute("class")).toContain(
					"rtl:[&:dir(rtl)]:-scale-x-100"
				);
			}
		} finally {
			document.documentElement.removeAttribute("dir");
		}
	});

	test("an LTR browser UI keeps the pointer at the top-right", async () => {
		useBrowserLanguage("en-US");
		await renderPanel();
		expect(pointer()?.getAttribute("dir")).toBe("ltr");
		expect(toolbar()?.getAttribute("dir")).toBe("ltr");
	});

	test("the where copy never names a corner", () => {
		for (const browser of [
			"chrome",
			"brave",
			"edge",
			"opera",
			"firefox",
			"safari",
			"other",
		] as const) {
			const { where } = browserDownloadHint(browser, "windows");
			expect(where).not.toMatch(/\b(?:top|left|right|corner)\b/i);
		}
	});
});
