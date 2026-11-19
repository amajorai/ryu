import { expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { billingFailureMessage } from "./billing.ts";

const tl: LiteralMessage = (source, values) =>
	`[${source}]${values ? JSON.stringify(values) : ""}`;

test("an unexpected checkout or license status is one catalogued sentence", () => {
	expect(billingFailureMessage("checkout", 502, tl)).toBe(
		'[Checkout failed ({status}).]{"status":"502"}'
	);
	expect(billingFailureMessage("license", 500, tl)).toBe(
		'[License validation failed ({status}).]{"status":"500"}'
	);
});

test("without a translator the English sentence is formatted", () => {
	expect(billingFailureMessage("checkout", 502)).toBe("Checkout failed (502).");
});
