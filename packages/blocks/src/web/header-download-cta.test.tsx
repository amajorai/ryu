import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Same DOM bootstrap as download-menu.test.tsx: the menu's static graph loads
// Radix, which must see a DOM on first load for later DOM suites.
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
const { HeaderDownloadCta } = await import("./header-download-cta.tsx");

describe("HeaderDownloadCta", () => {
	test("draws the hero's 'Download for <OS logo>' label with the arch reveal", () => {
		const html = renderToStaticMarkup(<HeaderDownloadCta variant="mono" />);
		expect(html).toContain("Download for");
		expect(html).toContain('data-slot="download-os-logo"');
		// The hover/focus arch reveal keys off this group on the primary button.
		expect(html).toContain("group/download");
		expect(html).toContain('aria-label="More download options"');
		expect(html).not.toContain('data-testid="landing-header-download-beam"');
	});

	test("beams the transparent hero header variant", () => {
		const html = renderToStaticMarkup(
			<HeaderDownloadCta beam variant="mono" />
		);
		expect(html).toContain("Download for");
		expect(html).toContain('data-testid="landing-header-download-beam"');
	});
});
