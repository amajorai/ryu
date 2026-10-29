import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OgCard, ogLabel } from "./og-card.tsx";
import { OG_LOGO, OG_PRISM_FRAME } from "./og-frames.generated.ts";

describe("social card composition", () => {
	it("draws the brand card on the Prism frame with the README mark", () => {
		const html = renderToStaticMarkup(<OgCard />);
		expect(OG_PRISM_FRAME.startsWith("data:image/jpeg;base64,")).toBe(true);
		expect(OG_LOGO.startsWith("data:image/png;base64,")).toBe(true);
		expect(html).toContain(OG_PRISM_FRAME);
		expect(html).toContain(OG_LOGO);
		expect(html).toContain("88px");
		expect(html).not.toContain("border:");
	});
	it("anchors white type to the bottom-left corner", () => {
		const html = renderToStaticMarkup(<OgCard title="Example" />);
		expect(html).toContain("justify-content:flex-end");
		expect(html).toContain("align-items:flex-start");
		expect(html).toContain("color:#ffffff");
		expect(html).not.toContain("text-align:center");
	});
	it("uses a caller supplied backdrop instead of the Prism frame", () => {
		const html = renderToStaticMarkup(
			<OgCard background="data:image/jpeg;base64,AAAA" title="Docs page" />
		);
		expect(html).toContain("data:image/jpeg;base64,AAAA");
		expect(html).not.toContain(OG_PRISM_FRAME);
	});
	it("renders a bounded description under the title", () => {
		const html = renderToStaticMarkup(
			<OgCard description={`Short summary ${"x".repeat(400)}`} title="Post" />
		);
		expect(html).toContain("Short summary");
		expect(html).not.toContain("x".repeat(200));
		expect(html).toContain("…");
	});
	it("renders one title and a short context without repeating it", () => {
		const html = renderToStaticMarkup(
			<OgCard eyebrow="Marketplace" title="Marketplace" />
		);
		expect(html.match(/>Marketplace</g)).toHaveLength(1);
		expect(html).not.toContain("Ryu Marketplace");
		expect(html).not.toContain("border:");
	});
	it.each([
		"App",
		"Model",
		"Skill",
		"Plugin",
		"Agent",
		"Workflow",
		"Marketplace",
		"Blog",
		"Docs",
	])("uses a plain Ryu %s label without bullets", (context) => {
		const html = renderToStaticMarkup(
			<OgCard eyebrow={context} title="Example" />
		);
		expect(html).toContain(`Ryu ${context}`);
		expect(html).not.toMatch(/[·•]/u);
	});
	it("normalizes whitespace and preserves Unicode when shortening names", () => {
		expect(ogLabel("  Browser\n app  ")).toBe("Browser app");
		expect(ogLabel("😀😀😀", 2)).toBe("😀…");
		expect(ogLabel(undefined)).toBe("");
	});
	it("escapes user authored names instead of interpreting HTML", () => {
		const html = renderToStaticMarkup(
			<OgCard title="<script>alert(1)</script>" />
		);
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});
});
