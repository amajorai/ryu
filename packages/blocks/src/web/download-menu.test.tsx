import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The menu's static graph reaches vaul and Radix (through the @ryu/ui dropdown's
// phone drawer), and Radix picks its layout effect when it first loads: with no
// DOM it keeps a no-op for the whole process. Register the DOM before loading
// the menu, so a DOM suite sharing this process (download-send-drawer.test.tsx)
// can still mount its portal. Server markup is unaffected: renderToStaticMarkup
// runs no effects.
const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register({ url: "https://ryu.test/" });
}

afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

const { renderToStaticMarkup } = await import("react-dom/server");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RELEASES_PAGE, resetReleasesCache } = await import(
	"./download-assets.ts"
);
const { DownloadMenu } = await import("./download-menu.tsx");
const { subscribeDownloadStarted } = await import("./download-started.ts");
type DownloadStartedDetail =
	import("./download-started.ts").DownloadStartedDetail;

const MENU_SOURCE = readFileSync(
	new URL("./download-menu.tsx", import.meta.url),
	"utf8"
);

describe("DownloadMenu", () => {
	test("server markup is the split button: a releases-page link and the menu trigger", () => {
		const html = renderToStaticMarkup(<DownloadMenu />);
		expect(html).toContain('role="group"');
		expect(html).toContain(`href="${RELEASES_PAGE}"`);
		expect(html).toContain('target="_blank"');
		expect(html).toContain(">Download<");
		expect(html).toContain('aria-label="More download options"');
		// Closed, the menu renders no body on the server (nor, now, any chunk).
		expect(html).not.toContain("Open Web App");
		expect(html).not.toContain("All versions");
	});

	test("outline variant is one plain link with no menu", () => {
		const html = renderToStaticMarkup(<DownloadMenu variant="outline" />);
		expect(html).toContain(`href="${RELEASES_PAGE}"`);
		expect(html).not.toContain('aria-label="More download options"');
	});

	test("showOsLogo renders the logo label inside a hover group", () => {
		const html = renderToStaticMarkup(
			<DownloadMenu showOsLogo transparentBackground variant="outline" />
		);
		expect(html).toContain("Download for");
		expect(html).toContain('data-slot="download-os-logo"');
		expect(html).toContain("group/download");
		expect(html).not.toContain(">Download<");
	});

	test("an undivided split pill balances its padding around the chevron", () => {
		const container = document.createElement("div");
		const classesOf = (separated: boolean) => {
			container.innerHTML = renderToStaticMarkup(
				<DownloadMenu
					showOsLogo
					showSeparator={separated}
					size="sm"
					variant="mono"
				/>
			);
			const primary = container.querySelector("a");
			const trigger = container.querySelector(
				'button[aria-label="More download options"]'
			);
			return {
				primary: primary?.className.split(/\s+/) ?? [],
				trigger: trigger?.className.split(/\s+/) ?? [],
			};
		};

		// No divider: the primary's end is trimmed and the chevron segment hugs
		// the right end instead of sitting centered in a square.
		const undivided = classesOf(false);
		expect(undivided.primary).toContain("pe-1");
		expect(undivided.trigger).toEqual(
			expect.arrayContaining(["w-auto", "ps-0.5", "pe-2"])
		);

		// With a divider the segments stay separate, square-chevron buttons.
		const divided = classesOf(true);
		expect(divided.primary).not.toContain("pe-1");
		expect(divided.trigger).not.toContain("w-auto");
		expect(divided.trigger).toContain("w-8");
	});

	test("loads the dropdown body on intent, never with the page", () => {
		// A static import (or re-export) would put the whole menu body and the
		// page-level download.tsx graph into every page's header chunk.
		expect(MENU_SOURCE).not.toMatch(
			/^\s*(?:import|export)\s[^;]*from\s+["']\.\/download-dropdown-content\.tsx["']/m
		);
		expect(MENU_SOURCE).toContain('import("./download-dropdown-content.tsx")');
		expect(MENU_SOURCE).toMatch(/onFocus=\{requestMenu\}/);
		expect(MENU_SOURCE).toMatch(/onPointerEnter=\{requestMenu\}/);
		expect(MENU_SOURCE).toMatch(
			/<DropdownMenu onOpenChange=\{handleMenuOpenChange\}>/
		);
	});

	test("a failed menu chunk resolves to a releases-page fallback instead of throwing", () => {
		// Without a rejection handler, `lazy` rethrows the failed import during
		// render and takes the page down to its nearest error boundary.
		expect(MENU_SOURCE).toContain(
			"() => ({ default: DownloadDropdownFallback })"
		);
	});
});

const WINDOWS_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const SETUP_ASSET = {
	browser_download_url:
		"https://github.com/amajorai/ryu/releases/download/v0.1.1/Ryu_0.1.1_x64-setup.exe",
	name: "Ryu_0.1.1_x64-setup.exe",
};

/** Wait on the clock for the releases fetch and React to commit. */
async function settle(done: () => boolean, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (!done() && Date.now() < deadline) {
		await act(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		});
	}
}

/** Click the primary link without letting the DOM follow it. */
function clickPrimary(anchor: HTMLAnchorElement) {
	const swallow = (event: Event) => event.preventDefault();
	document.addEventListener("click", swallow);
	anchor.dispatchEvent(
		new MouseEvent("click", { bubbles: true, cancelable: true })
	);
	document.removeEventListener("click", swallow);
}

describe("DownloadMenu post-download guide", () => {
	test("announces a direct installer download, never the releases-page fallback", async () => {
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		Object.defineProperty(navigator, "userAgent", {
			configurable: true,
			value: WINDOWS_UA,
		});
		resetReleasesCache();
		const originalFetch = globalThis.fetch;
		let resolveReleases: (response: Response) => void = () => undefined;
		const releasesResponse = new Promise<Response>((resolve) => {
			resolveReleases = resolve;
		});
		globalThis.fetch = (() => releasesResponse) as unknown as typeof fetch;
		const announced: DownloadStartedDetail[] = [];
		const unsubscribe = subscribeDownloadStarted((detail) => {
			announced.push(detail);
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(<DownloadMenu />);
			});
			const primary = () =>
				container.querySelector<HTMLAnchorElement>('[role="group"] a[href]');

			// Releases not loaded yet: the button opens the releases page.
			expect(primary()?.getAttribute("href")).toBe(RELEASES_PAGE);
			await act(async () => {
				clickPrimary(primary() as HTMLAnchorElement);
			});
			expect(announced).toEqual([]);

			resolveReleases(
				new Response(
					JSON.stringify([
						{
							assets: [SETUP_ASSET],
							html_url: `${RELEASES_PAGE}/tag/v0.1.1`,
							id: 1,
							name: "v0.1.1",
							published_at: "2026-10-01T00:00:00Z",
							tag_name: "v0.1.1",
						},
					]),
					{ status: 200 }
				)
			);
			await settle(
				() =>
					primary()?.getAttribute("href") === SETUP_ASSET.browser_download_url
			);
			expect(primary()?.getAttribute("download")).toBe(SETUP_ASSET.name);
			await act(async () => {
				clickPrimary(primary() as HTMLAnchorElement);
			});
			expect(announced).toEqual([
				{
					arch: "intel",
					assetName: SETUP_ASSET.name,
					href: SETUP_ASSET.browser_download_url,
					os: "windows",
				},
			]);
		} finally {
			unsubscribe();
			await act(async () => root.unmount());
			container.remove();
			globalThis.fetch = originalFetch;
			resetReleasesCache();
			Reflect.deleteProperty(navigator, "userAgent");
		}
	}, 30_000);
});
