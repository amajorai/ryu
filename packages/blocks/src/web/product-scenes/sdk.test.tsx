import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SdkScene } from "./sdk.tsx";

test("the SDK scene server-renders a decorative code-to-agent drawing", () => {
	const html = renderToStaticMarkup(<SdkScene />);

	expect(html).toContain('data-testid="realm-visual-sdk"');
	expect(html).toContain('aria-hidden="true"');
	expect(html).toContain("$ create-ryu-app");
	for (const word of [">agent<", ">model<", ">tool<", ">skill<", ">mcp<"]) {
		expect(html).toContain(word);
	}
	// The model, MCP and skill edges plus the packet overlay all trace by length.
	expect(html.match(/pathLength="100"/g)).toHaveLength(4);
});

test("the SDK scene markup is deterministic and carries no generated ids", () => {
	const first = renderToStaticMarkup(<SdkScene />);
	const second = renderToStaticMarkup(<SdkScene />);

	expect(first).toBe(second);
	expect(first).not.toMatch(/\sid="/);
	expect(first).not.toMatch(/:r[0-9a-z]+:|«r/);
	// The server frame is the finished pose: motion is added only after the
	// stage reports it is in view.
	expect(first).not.toContain("data-inview");
});
