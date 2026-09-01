import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ConsoleLanding from "./build-landing.tsx";

test("Console landing shows the power-user product story", () => {
	const html = renderToStaticMarkup(<ConsoleLanding />);

	expect(html).toContain('data-testid="product-page-console"');
	expect(html).toContain("data-product-hero-layout=");
	expect(html).toContain("data-product-bento-layout=");
	expect(html).toContain("Your AI, your models, your rules");
	expect(html).toContain("See what happens before you hand it off");
	expect(html).toContain("Make your setup");
	expect(html).toContain("reusable.");
	expect(html).toContain('data-testid="hero-workflow-stage"');
});
