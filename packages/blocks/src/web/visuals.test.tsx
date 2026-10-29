import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OsVisual } from "./visuals.tsx";

test("OS product visual uses shared semantic surfaces", () => {
	const html = renderToStaticMarkup(<OsVisual />);

	expect(html).toContain("bg-muted");
	expect(html).toContain("bg-foreground text-background");
	expect(html).not.toContain("bg-primary");
	expect(html).toContain('aria-label="Dock"');
	expect(html).not.toContain("rgba(143,123,242");
	expect(html).not.toContain("rgba(45,212,191");
});
