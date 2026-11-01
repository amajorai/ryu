import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register the DOM before React loads (see download-menu.test.tsx).
const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register({ url: "https://ryu.test/" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { BrowserToolbarMock, DownloadCornerPointer } = await import(
	"./download-guide-browser.tsx"
);
const { browserDownloadHint } = await import("./download-guide.ts");

type Root = import("react-dom/client").Root;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(node: React.ReactNode) {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(node);
	});
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	container?.remove();
	root = null;
	container = null;
});

afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

describe("BrowserToolbarMock", () => {
	test("draws a toolbar for a browser with a top-right download control", async () => {
		await render(
			<BrowserToolbarMock
				fileName="Ryu_1.2.3_aarch64.dmg"
				hint={browserDownloadHint("firefox", "macos")}
				os="macos"
			/>
		);
		const toolbar = document.querySelector(
			"[data-testid='download-guide-toolbar']"
		);
		expect(toolbar?.getAttribute("data-browser")).toBe("firefox");
		expect(toolbar?.textContent).toContain("Ryu_1.2.3_aarch64.dmg");
		expect(
			document.querySelector("[data-testid='download-guide-folder']")
		).toBeNull();
	});

	test("falls back to a Downloads folder for an unknown browser", async () => {
		await render(
			<BrowserToolbarMock
				fileName="Ryu_x64-setup.exe"
				hint={browserDownloadHint("other", "windows")}
				os="windows"
			/>
		);
		const folder = document.querySelector(
			"[data-testid='download-guide-folder']"
		);
		expect(folder?.textContent).toContain("Ryu_x64-setup.exe");
		expect(
			document.querySelector("[data-testid='download-guide-toolbar']")
		).toBeNull();
	});
});

describe("DownloadCornerPointer", () => {
	test("portals a decorative caption naming the browser into the body", async () => {
		await render(<DownloadCornerPointer name="Safari" />);
		const pointer = document.body.querySelector(
			"[data-testid='download-guide-pointer']"
		);
		expect(pointer?.parentElement).toBe(document.body);
		expect(pointer?.getAttribute("aria-hidden")).toBe("true");
		expect(pointer?.textContent).toContain("In the Safari toolbar");
	});
});
