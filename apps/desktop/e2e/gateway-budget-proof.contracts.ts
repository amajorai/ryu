import { z } from "zod";
import type {
	BudgetRule,
	GatewayAlertTier,
	GatewayBudgetConfig,
} from "../src/lib/api/gateway.ts";
import {
	type PluginDocument,
	pluginDocumentSchema,
} from "../src/lib/api/plugin-wire-values.ts";

// Playwright loads this file in Node, where a runtime import of gateway.ts pulls
// in the whole Desktop API client and the Next.js settings adapter it configures,
// which Node cannot resolve. The record type makes the compiler reject a missing
// or extra tier, so this list cannot drift from the product's union.
const alertTierWireValues: { [Tier in GatewayAlertTier]: Tier } = {
	silent: "silent",
	warn: "warn",
	fanout: "fanout",
	email: "email",
};

const budgetRuleFieldsSchema = z.object({
	action: z.enum(["notify", "downgrade", "restrict", "stop"]),
	alert: z.enum(alertTierWireValues).optional(),
	downgrade_to: z.string().nullable().optional(),
	include: z
		.object({ media: z.boolean(), model: z.boolean(), tools: z.boolean() })
		.optional(),
	limit: z.number(),
	restrict_max_tokens: z.number().optional(),
}) satisfies z.ZodType<BudgetRule>;
const budgetConfigFieldsSchema = z.object({
	agents: z.record(z.string(), budgetRuleFieldsSchema),
	session: budgetRuleFieldsSchema,
	users: z.record(z.string(), budgetRuleFieldsSchema),
}) satisfies z.ZodType<GatewayBudgetConfig>;
const budgetWriteFieldsSchema = z.object({ budgets: budgetConfigFieldsSchema });
export const gatewayBudgetWriteProofSchema = z.custom<
	z.output<typeof budgetWriteFieldsSchema> & PluginDocument
>((value) => {
	const document = pluginDocumentSchema.safeParse(value);
	if (!(document.success && budgetWriteFieldsSchema.safeParse(value).success)) {
		return false;
	}
	const budgets = pluginDocumentSchema.safeParse(document.data.budgets);
	if (!budgets.success) {
		return false;
	}
	return ["agents", "users"].every((scope) => {
		const rules = pluginDocumentSchema.safeParse(budgets.data[scope]);
		return (
			rules.success &&
			Object.values(rules.data).every(
				(rule) => budgetRuleFieldsSchema.safeParse(rule).success
			)
		);
	});
});
