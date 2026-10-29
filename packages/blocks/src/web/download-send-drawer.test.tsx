import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register({ url: "https://ryu.test/" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { DownloadMenu } = await import("./download-menu.tsx");
const { WEBAPP_URL } = await import("./download-catalog.tsx");
// Load the drawer chunk up front: the menu imports it lazily, and on a loaded
// machine that first import can outlast the wait below.
await import("./download-send-drawer.tsx");

const ANDROID_UA =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const WINDOWS_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function useUserAgent(userAgent: string) {
	Object.defineProperty(navigator, "userAgent", {
		configurable: true,
		value: userAgent,
	});
}

afterEach(() => {
	Reflect.deleteProperty(navigator, "userAgent");
	document.body.replaceChildren();
});

afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

/**
 * Let the lazily imported drawer resolve and React commit it. The import can
 * take seconds on a loaded machine, so wait on the clock, not a tick count.
 */
async function settle(done: () => boolean, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (!done() && Date.now() < deadline) {
		await act(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		});
	}
}

async function renderMenu() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(<DownloadMenu />);
	});
	return { container, root };
}

/** Clicks the primary Download link; undefined when there is none. */
function clickPrimary(container: HTMLElement): MouseEvent | undefined {
	const primary = container.querySelector<HTMLAnchorElement>(
		'[role="group"] a[href]'
	);
	if (!primary) {
		return;
	}
	const click = new MouseEvent("click", { bubbles: true, cancelable: true });
	primary.dispatchEvent(click);
	return click;
}

const drawerOf = () =>
	document.querySelector('[data-testid="download-send-drawer"]');

test("on a phone, Download opens the send-to-yourself drawer instead of the installer", async () => {
	useUserAgent(ANDROID_UA);
	const { container, root } = await renderMenu();
	try {
		let click: MouseEvent | undefined;
		await act(async () => {
			click = clickPrimary(container);
		});
		expect(click?.defaultPrevented).toBe(true);
		await settle(() => drawerOf() !== null);

		expect(drawerOf()?.textContent).toContain("Ryu runs on your computer");
		const hrefs = Object.fromEntries(
			Array.from(
				document.querySelectorAll<HTMLAnchorElement>("[data-share-target]"),
				(link) => [link.dataset.shareTarget, link.getAttribute("href")]
			)
		);
		// Another suite may have registered the DOM first, with its own origin.
		const pageUrl = `${window.location.origin}/download`;
		const body = encodeURIComponent(
			`Download Ryu on your computer: ${pageUrl}`
		);
		expect(hrefs).toEqual({
			email: `mailto:?subject=Download%20Ryu&body=${body}`,
			messages: `sms:?body=${body}`,
			telegram: `https://t.me/share/url?url=${encodeURIComponent(pageUrl)}&text=${encodeURIComponent("Download Ryu on your computer:")}`,
			whatsapp: `https://wa.me/?text=${body}`,
		});
		// No QR code: nobody scans their own phone's screen.
		expect(drawerOf()?.querySelector("svg[data-qr], canvas")).toBeNull();
		// The web app is the one option usable on the phone itself.
		const footerLinks = Array.from(
			drawerOf()?.querySelectorAll<HTMLAnchorElement>(
				"a:not([data-share-target])"
			) ?? [],
			(link) => [link.textContent, link.getAttribute("href")]
		);
		expect(footerLinks).toEqual([
			["Open the web app", WEBAPP_URL],
			["See all download options", "/download"],
		]);
		// Focus moves into the modal, onto the first way to send the link,
		// instead of staying on the hidden trigger.
		expect(
			(document.activeElement as HTMLElement | null)?.dataset.shareTarget
		).toBe("whatsapp");
		// Both segments say they open a dialog, and the chevron says what it does.
		expect(
			container
				.querySelector('[role="group"] a[href]')
				?.getAttribute("aria-haspopup")
		).toBe("dialog");
		const chevron = container.querySelector(
			'[aria-label="Send the download link to yourself"]'
		);
		expect(chevron?.getAttribute("aria-haspopup")).toBe("dialog");
	} finally {
		await act(async () => root.unmount());
	}
}, 30_000);

test("on a desktop, Download stays the installer link and no drawer mounts", async () => {
	useUserAgent(WINDOWS_UA);
	const { container, root } = await renderMenu();
	try {
		let click: MouseEvent | undefined;
		await act(async () => {
			click = clickPrimary(container);
		});
		expect(click?.defaultPrevented).toBe(false);
		await settle(() => false, 200);
		expect(drawerOf()).toBeNull();
		expect(
			container.querySelector('[aria-label="More download options"]')
		).not.toBeNull();
	} finally {
		await act(async () => root.unmount());
	}
}, 30_000);
