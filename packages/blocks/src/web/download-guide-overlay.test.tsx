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
const { DownloadGuideHost } = await import("./download-guide-overlay.tsx");
const { DownloadGuidePanel, INSTALL_DOCS_PATH } = await import(
	"./download-guide-panel.tsx"
);
const { shortcutKeys } = await import("./download-guide-shortcut.tsx");
const { stepIcon } = await import("./download-guide-steps.tsx");
const { announceDownloadStarted } = await import("./download-started.ts");
const { docsHref } = await import("./data/resources.tsx");

type Detail = import("./download-started.ts").DownloadStartedDetail;
type Browser = import("./download-guide.ts").GuideBrowser;

const DESKTOP_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const WINDOWS_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const ANDROID_UA =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

const MAC_DETAIL: Detail = {
	os: "macos",
	arch: "arm",
	assetName: "Ryu_1.2.3_aarch64.dmg",
	href: "https://example.test/Ryu_1.2.3_aarch64.dmg",
};

function useUserAgent(userAgent: string) {
	Object.defineProperty(navigator, "userAgent", {
		configurable: true,
		value: userAgent,
	});
}

const roots: { unmount: () => void }[] = [];

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	Reflect.deleteProperty(navigator, "userAgent");
	document.body.replaceChildren();
});

afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

async function mount(element: React.ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(element);
	});
	return root;
}

/** Wait on the clock for lazy chunks and Base UI to commit. */
async function settle(done: () => boolean, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (!done() && Date.now() < deadline) {
		await act(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		});
	}
}

const guide = () => document.querySelector('[data-testid="download-guide"]');
const guides = () =>
	document.querySelectorAll('[data-testid="download-guide"]').length;
const text = () => document.body.textContent ?? "";

async function renderPanel(detail: Detail, browser: Browser) {
	await mount(
		<DownloadGuidePanel
			browser={browser}
			detail={detail}
			onOpenChange={() => undefined}
			open
		/>
	);
	await settle(() => guide() !== null);
}

describe("DownloadGuidePanel", () => {
	test("macOS + Chrome: heading, file, toolbar mock, pointer, shortcut and dmg steps", async () => {
		useUserAgent(DESKTOP_UA);
		await renderPanel(MAC_DETAIL, "chrome");
		const dialog = guide();
		expect(dialog?.getAttribute("role")).toBe("dialog");
		expect(text()).toContain("Your download has started");
		expect(text()).toContain("Ryu_1.2.3_aarch64.dmg");
		expect(text()).toContain("macOS · Apple Silicon");
		expect(text()).toContain("Find it in Chrome");
		expect(
			document
				.querySelector('[data-testid="download-guide-toolbar"]')
				?.getAttribute("data-browser")
		).toBe("chrome");
		expect(
			document.querySelector('[data-testid="download-guide-pointer"]')
		).not.toBeNull();
		const keys = [...document.querySelectorAll('[data-slot="kbd"]')].map(
			(key) => key.textContent
		);
		expect(keys).toEqual(["⌥", "⌘", "L"]);
		const steps = document.querySelectorAll(
			'[data-testid="download-guide-steps"] > li'
		);
		expect(steps).toHaveLength(3);
		expect(steps[1]?.textContent).toContain("Drag Ryu to Applications");
		expect(
			document.querySelector('[data-testid="download-guide-troubleshooting"]')
				?.textContent
		).toContain("Open Anyway");
	});

	test("footer retries the same file and links the install docs in a new tab", async () => {
		await renderPanel(MAC_DETAIL, "safari");
		const retry = [...document.querySelectorAll("a")].find((anchor) =>
			anchor.textContent?.includes("Try again")
		);
		expect(retry?.getAttribute("href")).toBe(MAC_DETAIL.href);
		expect(retry?.getAttribute("download")).toBe("Ryu_1.2.3_aarch64.dmg");
		const docs = [...document.querySelectorAll("a")].find((anchor) =>
			anchor.textContent?.includes("install guide")
		);
		expect(docs?.getAttribute("href")).toBe(docsHref(INSTALL_DOCS_PATH));
		expect(docs?.getAttribute("target")).toBe("_blank");
		expect(docs?.getAttribute("rel")).toBe("noopener noreferrer");
	});

	test("Windows + Edge: SmartScreen callout and Ctrl+J", async () => {
		useUserAgent(WINDOWS_UA);
		await renderPanel(
			{
				os: "windows",
				arch: "intel",
				assetName: "Ryu_1.2.3_x64-setup.exe",
				href: "https://example.test/setup.exe",
			},
			"edge"
		);
		expect(text()).toContain("Install Ryu on Windows");
		expect(text()).toContain("Run anyway");
		const keys = [...document.querySelectorAll('[data-slot="kbd"]')].map(
			(key) => key.textContent
		);
		expect(keys).toEqual(["Ctrl", "J"]);
	});

	test("the shortcut follows the visitor's OS, not the installer's", async () => {
		useUserAgent(DESKTOP_UA);
		await renderPanel(
			{
				os: "linux",
				arch: "intel",
				assetName: "Ryu_1.2.3_amd64.deb",
				href: "https://example.test/Ryu_1.2.3_amd64.deb",
			},
			"firefox"
		);
		expect(text()).toContain("Install Ryu on Linux");
		const keys = [...document.querySelectorAll('[data-slot="kbd"]')].map(
			(key) => key.textContent
		);
		expect(keys).toEqual(["⌘", "J"]);
		expect(
			document.querySelector('[data-testid="download-shortcut"] .sr-only')
				?.textContent
		).toBe("⌘J");
	});

	test("focus starts on the heading, with one close control and step headings under the section", async () => {
		useUserAgent(DESKTOP_UA);
		await renderPanel(MAC_DETAIL, "chrome");
		await settle(
			() => document.activeElement?.textContent === "Your download has started",
			2000
		);
		expect(document.activeElement?.tagName).toBe("H2");
		expect(document.activeElement?.textContent).toBe(
			"Your download has started"
		);
		// Only the footer's Close: the corner X is turned off.
		expect(
			document.querySelectorAll('[data-slot="dialog-close"]')
		).toHaveLength(1);
		const stepHeadings = document.querySelectorAll(
			'[data-testid="download-guide-steps"] h4'
		);
		expect(stepHeadings).toHaveLength(3);
	});

	test("Linux .deb: copyable commands using the real file name", async () => {
		await renderPanel(
			{
				os: "linux",
				arch: "intel",
				assetName: "Ryu_1.2.3_amd64.deb",
				href: "https://example.test/ryu.deb",
			},
			"firefox"
		);
		const commands = [...document.querySelectorAll("code")].map(
			(code) => code.textContent
		);
		expect(commands).toEqual([
			"cd ~/Downloads",
			"sudo apt install ./Ryu_1.2.3_amd64.deb",
		]);
		expect(
			document.querySelectorAll('button[aria-label="Copy command"]')
		).toHaveLength(2);
		expect(
			document.querySelector('[data-testid="download-guide-troubleshooting"]')
		).toBeNull();
	});

	test("copying a command writes it to the clipboard and confirms", async () => {
		const written: string[] = [];
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: (value: string) => {
					written.push(value);
					return Promise.resolve();
				},
			},
		});
		await renderPanel(
			{
				os: "linux",
				arch: null,
				assetName: "Ryu_1.2.3_amd64.AppImage",
				href: "https://example.test/ryu.AppImage",
			},
			"chrome"
		);
		const copy = document.querySelector<HTMLButtonElement>(
			'button[aria-label="Copy command"]'
		);
		await act(async () => {
			copy?.click();
			await Promise.resolve();
		});
		expect(written).toEqual([
			"cd ~/Downloads && chmod +x ./Ryu_1.2.3_amd64.AppImage",
		]);
		expect(
			document.querySelector('button[aria-label="Copied"]')
		).not.toBeNull();
		Reflect.deleteProperty(navigator, "clipboard");
	});

	test("an unknown browser gets the Downloads folder and no arrow", async () => {
		await renderPanel({ ...MAC_DETAIL, assetName: null }, "other");
		expect(text()).toContain("Find the installer");
		expect(text()).toContain("Ryu installer");
		expect(
			document.querySelector('[data-testid="download-guide-folder"]')
		).not.toBeNull();
		expect(
			document.querySelector('[data-testid="download-guide-pointer"]')
		).toBeNull();
		expect(document.querySelectorAll('[data-slot="kbd"]')).toHaveLength(0);
	});
});

describe("DownloadGuideHost", () => {
	test("opens once on an announced download, however many hosts are mounted", async () => {
		useUserAgent(DESKTOP_UA);
		await mount(
			<>
				<DownloadGuideHost />
				<DownloadGuideHost />
				<DownloadGuideHost />
			</>
		);
		expect(guide()).toBeNull();
		await act(async () => {
			announceDownloadStarted(MAC_DETAIL);
		});
		await settle(() => guide() !== null);
		expect(guides()).toBe(1);
		expect(text()).toContain("Ryu_1.2.3_aarch64.dmg");
	});

	test("the next host takes over when the owner unmounts", async () => {
		useUserAgent(DESKTOP_UA);
		const first = await mount(<DownloadGuideHost />);
		await mount(<DownloadGuideHost />);
		await act(async () => {
			first.unmount();
		});
		await act(async () => {
			announceDownloadStarted(MAC_DETAIL);
		});
		await settle(() => guide() !== null);
		expect(guides()).toBe(1);
	});

	test("Close dismisses the guide", async () => {
		useUserAgent(DESKTOP_UA);
		await mount(<DownloadGuideHost />);
		await act(async () => {
			announceDownloadStarted(MAC_DETAIL);
		});
		await settle(() => guide() !== null);
		const close = [...document.querySelectorAll("button")].find(
			(button) => button.textContent === "Close"
		);
		await act(async () => {
			close?.click();
		});
		await settle(() => guide() === null);
		expect(guide()).toBeNull();
	});

	test("phones never see it", async () => {
		useUserAgent(ANDROID_UA);
		await mount(<DownloadGuideHost />);
		await act(async () => {
			announceDownloadStarted(MAC_DETAIL);
		});
		await settle(() => guide() !== null, 300);
		expect(guide()).toBeNull();
	});
});

describe("guide helpers", () => {
	test("shortcutKeys splits plus-joined and macOS glyph shortcuts", () => {
		expect(shortcutKeys("Ctrl+Shift+Y")).toEqual(["Ctrl", "Shift", "Y"]);
		expect(shortcutKeys("⌥⌘L")).toEqual(["⌥", "⌘", "L"]);
		expect(shortcutKeys("⌘J")).toEqual(["⌘", "J"]);
	});

	test("every step of every format has an icon", () => {
		for (const format of [
			"appimage",
			"deb",
			"dmg",
			"exe",
			"msi",
			"rpm",
		] as const) {
			for (const index of [0, 1, 2, 5]) {
				expect(typeof stepIcon(format, index)).not.toBe("undefined");
			}
		}
	});
});
