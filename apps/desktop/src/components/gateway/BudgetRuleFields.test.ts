import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
const { spendCapPlaceholder } = await import("./BudgetRuleFields.tsx");

test("the spend cap example uses the reader's decimal mark", () => {
	expect(spendCapPlaceholder("en")).toBe("1.00");
	expect(spendCapPlaceholder("de")).toBe("1,00");
});
