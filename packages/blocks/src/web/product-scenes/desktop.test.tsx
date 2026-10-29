import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopProductScene } from "./desktop.tsx";

test("desktop scene server-renders a decorative, deterministic frame", () => {
	const html = renderToStaticMarkup(<DesktopProductScene />);

	expect(html).toContain('data-testid="realm-visual-desktop"');
	expect(html).toContain('aria-hidden="true"');
	expect(html).toContain('viewBox="0 0 320 172"');
	for (const label of ["CC", "Cx", "local", "your key", "plan"]) {
		expect(html).toContain(`>${label}</text>`);
	}
	expect(html).not.toMatch(/\sid="/);
	expect(html).not.toContain('class=""');
	expect(html).not.toContain("undefined");
	expect(renderToStaticMarkup(<DesktopProductScene />)).toBe(html);
});
