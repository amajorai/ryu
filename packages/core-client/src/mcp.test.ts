import { describe, expect, it } from "bun:test";
import { mcpListedToolFields } from "./mcp.ts";

const tool = (appBackend: string) => ({
	id: "app.demo",
	server: "app",
	name: "demo",
	app_backend: appBackend,
});

describe("MCP tool listing", () => {
	it("accepts every app backend tag current Core reports", () => {
		for (const tag of ["Alias", "InlineJs", "Http", "Command"]) {
			expect(mcpListedToolFields.safeParse(tool(tag)).success).toBe(true);
		}
	});

	// Core releases from before the `inline_js` rename report the same backend
	// as `InlineDeno`; a newer client must still parse their tool listings.
	it("accepts the pre-rename InlineDeno tag from older Core releases", () => {
		const parsed = mcpListedToolFields.parse(tool("InlineDeno"));
		expect(parsed.app_backend).toBe("InlineDeno");
	});
});
