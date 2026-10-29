import { describe, expect, it } from "bun:test";
import { providerRouteFor } from "./ProviderDesktopRouteSetting.tsx";

describe("provider desktop routes", () => {
	it("offers the Claude route only on the Claude subscription card", () => {
		expect(providerRouteFor("claude-pro-max")).toBe("claude");
		expect(providerRouteFor("anthropic")).toBeUndefined();
		expect(providerRouteFor("openai-codex")).toBeUndefined();
	});
});
