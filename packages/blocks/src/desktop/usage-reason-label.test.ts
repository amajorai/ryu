import { expect, test } from "bun:test";
import { usageReasonLabel } from "./usage.tsx";

test("labels Managed Agents debits in customer words and keeps unknown reasons raw", () => {
	expect(usageReasonLabel("managed_agents")).toBe("Managed Agents");
	expect(usageReasonLabel("gateway_usage")).toBe("Model usage");
	expect(usageReasonLabel("future_reason")).toBe("future_reason");
});
