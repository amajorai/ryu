import { expect, test } from "bun:test";
import { marketplaceAgentIdentityMode } from "./marketplace-detail.ts";

test("labels only exact Core agent identity modes", () => {
	expect(marketplaceAgentIdentityMode("managed")).toBe("managed");
	expect(marketplaceAgentIdentityMode("individual")).toBe("individual");
	expect(marketplaceAgentIdentityMode("mixed")).toBe("mixed");
	expect(marketplaceAgentIdentityMode("Managed")).toBeNull();
	expect(marketplaceAgentIdentityMode(undefined)).toBeNull();
	expect(marketplaceAgentIdentityMode(1)).toBeNull();
});
