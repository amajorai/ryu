import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DownloadOsLabel } from "./download-os-label.tsx";

describe("DownloadOsLabel", () => {
	test("names the OS with its logo and keeps the OS name for screen readers", () => {
		const html = renderToStaticMarkup(
			<DownloadOsLabel arch="intel" detected iconSize={16} os="windows" />
		);
		expect(html).toContain("Download for");
		expect(html).toContain('src="/logos/windows.svg"');
		expect(html).toContain('<span class="sr-only">Windows</span>');
		expect(html).toContain('data-os="windows"');
	});

	test("the architecture is collapsed at rest and morphs in on hover or focus", () => {
		const html = renderToStaticMarkup(
			<DownloadOsLabel arch="arm" detected iconSize={16} os="macos" />
		);
		const arch = html.match(/<span class="([^"]*)" data-slot="download-arch">/);
		expect(arch?.[1]).toContain("grid-cols-[minmax(0,0fr)]");
		expect(arch?.[1]).toContain("opacity-0");
		expect(arch?.[1]).toContain(
			"group-hover/download:grid-cols-[minmax(0,1fr)]"
		);
		expect(arch?.[1]).toContain(
			"group-focus-visible/download:grid-cols-[minmax(0,1fr)]"
		);
		expect(html).toContain("Apple Silicon");
	});

	test("leaves the architecture out until it is detected", () => {
		const html = renderToStaticMarkup(
			<DownloadOsLabel arch={null} detected iconSize={16} os="linux" />
		);
		expect(html).not.toContain('data-slot="download-arch"');
		expect(html).toContain('<span class="sr-only">Linux</span>');
	});

	test("hides the server's default OS guess until the browser is detected", () => {
		const html = renderToStaticMarkup(
			<DownloadOsLabel arch={null} detected={false} iconSize={16} os="macos" />
		);
		const logo = html.match(
			/<span class="([^"]*)" data-os="macos" data-slot="download-os-logo">/
		);
		expect(logo?.[1]).toContain("opacity-0");
	});

	test('keeps a visible gap between "Download for" and the OS logo, on the inline end', () => {
		const html = renderToStaticMarkup(
			<DownloadOsLabel arch={null} detected iconSize={16} os="macos" />
		);
		const lead = html.match(/<span class="([^"]*)" data-slot="download-for">/);
		// Logical margin, so the gap stays between the words and the logo in RTL.
		expect(lead?.[1]).toContain("me-2.5");
		expect(lead?.[1]).not.toContain("mr-2.5");
	});
});
