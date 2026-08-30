import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import HeroDesktopDemo from "./hero-desktop-demo.tsx";

test("hero desktop demo renders the real Ryu chat surface", () => {
	const html = renderToStaticMarkup(<HeroDesktopDemo />);

	expect(html).toContain('data-testid="hero-desktop-demo"');
	expect(html).toContain("Ryu Bot");
	expect(html).toContain("Prepare a weekly update from the project folder.");
	expect(html).not.toContain("rgba(139,92,246");
});
