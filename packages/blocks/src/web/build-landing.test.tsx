import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ConsoleLanding from "./build-landing.tsx";

test("Agent landing shows the power-user product story", () => {
	const html = renderToStaticMarkup(<ConsoleLanding />);

	expect(html).toContain('data-testid="product-page-agent"');
	expect(html).toContain("data-product-hero-layout=");
	expect(html).toContain("data-product-bento-layout=");
	expect(html).toContain("Run your agents your way");
	expect(html).toContain("Control and audit");
	expect(html).toContain('data-testid="console-workflow-visual"');
});
