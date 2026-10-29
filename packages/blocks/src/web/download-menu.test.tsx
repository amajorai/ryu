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
const { RELEASES_PAGE } = await import("./download-assets.ts");
const { DownloadMenu } = await import("./download-menu.tsx");

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
