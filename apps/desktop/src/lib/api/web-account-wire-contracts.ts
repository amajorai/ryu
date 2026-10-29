import { z } from "zod";
import type { GatewayProviderApplication } from "./gateway.ts";
import type { GatewayWebAccountsView } from "./web-service-accounts.ts";

export const webAccountRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const providerSchema = z.enum([
	"tavily",
	"brave",
	"serper",
	"exa",
	"linkup",
	"parallel",
	"perplexity-search",
	"google-pse",
	"searchapi",
	"firecrawl",
	"jina-reader",
]);
const contextSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("default") }),
	z.object({
		kind: z.literal("google_pse"),
		engine_id: z.string(),
		existing_customer_acknowledged: z.boolean(),
	}),
	z.object({ kind: z.literal("search_api"), engine: z.literal("google") }),
]);
const accountSchema = z.object({
	accountId: webAccountRevisionSchema,
	context: contextSchema,
	diagnostic: z
		.enum(["existing_customer_required", "google_pse_discontinued"])
		.nullish()
		.transform((value) => value ?? null),
	policy: z.object({
		name: z.string(),
		enabled: z.boolean(),
		priority: z.number().int().min(0).max(65_535),
	}),
});
const connectionSchema = z
	.object({
		provider: providerSchema,
		anonymous: z.boolean(),
		accounts: z.array(accountSchema).max(32),
	})
	.refine((value) => {
		if (
			value.anonymous &&
			(value.provider !== "jina-reader" || value.accounts.length)
		) {
			return false;
		}
		const expected =
			value.provider === "google-pse"
				? "google_pse"
				: value.provider === "searchapi"
					? "search_api"
					: "default";
		const identifiers = new Set<string>();
		for (const account of value.accounts) {
			if (
				identifiers.has(account.accountId) ||
				account.context.kind !== expected
			) {
				return false;
			}
			identifiers.add(account.accountId);
		}
		return true;
	});
export const gatewayWebAccountsSchema = z
	.object({
		webServiceSchema: z.literal(1),
		configRevision: webAccountRevisionSchema,
		providers: z.array(connectionSchema),
	})
	.refine(
		(value) =>
			new Set(value.providers.map((row) => row.provider)).size ===
			value.providers.length
	) satisfies z.ZodType<GatewayWebAccountsView>;
const applicationSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.enum(["applied", "already_applied"]),
		requestedRevision: webAccountRevisionSchema,
		appliedRevision: webAccountRevisionSchema,
		epoch: z.object({
			boot: z.string(),
			sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		}),
	}),
	z.object({
		status: z.literal("superseded"),
		requestedRevision: webAccountRevisionSchema,
		currentRevision: webAccountRevisionSchema,
	}),
	z.object({
		status: z.enum(["offline", "unmanaged"]),
		requestedRevision: webAccountRevisionSchema,
	}),
	z
		.object({
			status: z.literal("failed"),
			requestedRevision: webAccountRevisionSchema,
			code: z.string(),
			activeRevision: webAccountRevisionSchema.nullish(),
		})
		.transform((value) => ({
			status: value.status,
			requestedRevision: value.requestedRevision,
			code: value.code,
			activeRevision: value.activeRevision,
		})),
]) satisfies z.ZodType<GatewayProviderApplication>;
export const webAccountApplicationSchema = applicationSchema.optional();
export const webAccountSavedSchema = z.object({
	success: z.literal(true),
	persisted: z.literal(true),
	configRevision: webAccountRevisionSchema,
	gateway_application: z.json().optional(),
});
