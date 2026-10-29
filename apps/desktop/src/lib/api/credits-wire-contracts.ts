import { rpcJsonResponseSchema } from "@ryu/app-host/rpc";
import { z } from "zod";
import type {
	AutoTopupSettings,
	CreditAlertEvent,
	CreditAlertSettings,
	CreditProviderAllocation,
	CreditWallet,
	LedgerEntry,
	TopupQuote,
	UsageBreakdownRow,
	UsageResponse,
	UsageStats,
	WalletResponse,
	WalletUpdate,
} from "./credits.ts";

const ledgerEntrySchema = z
	.object({
		balanceAfter: z.number(),
		createdAt: z.string(),
		delta: z.number(),
		durationMs: z.union([z.number(), z.null()]),
		estimated: z.union([z.boolean(), z.null()]),
		id: z.string(),
		inputTokens: z.union([z.number(), z.null()]),
		model: z.union([z.string(), z.null()]),
		orgId: z.union([z.string(), z.null()]),
		outputTokens: z.union([z.number(), z.null()]),
		provider: z.union([z.string(), z.null()]),
		reason: z.string(),
		refId: z.union([z.string(), z.null()]),
		taskLabel: z.union([z.string(), z.null()]),
		upstreamProvider: z.union([z.string(), z.null()]),
		userId: z.union([z.string(), z.null()]),
		walletId: z.string(),
	})
	.catchall(z.json()) satisfies z.ZodType<LedgerEntry>;

const creditProviderAllocationSchema = z
	.object({
		expiresAt: z.union([z.string(), z.null()]),
		isFreeProvider: z.boolean(),
		label: z.string(),
		poolId: z.string(),
		remainingMicroUsd: z.number(),
	})
	.catchall(z.json()) satisfies z.ZodType<CreditProviderAllocation>;

const creditWalletSchema = z
	.object({
		availableMicroUsd: z.number().optional(),
		balanceBreakdownAvailable: z.boolean().optional(),
		balanceMicroUsd: z.number(),
		currency: z.string(),
		giftBalanceMicroUsd: z.union([z.number(), z.null()]).optional(),
		heldMicroUsd: z.number().optional(),
		id: z.string(),
		ownerId: z.string(),
		ownerType: z.string(),
		providerAllocations: z.array(creditProviderAllocationSchema).optional(),
		source: z.string().optional(),
		subscriptionBalanceMicroUsd: z.union([z.number(), z.null()]),
		topupBalanceMicroUsd: z.union([z.number(), z.null()]),
		unrestrictedBalanceMicroUsd: z.number().optional(),
		updatedAt: z.string(),
	})
	.catchall(z.json()) satisfies z.ZodType<CreditWallet>;

const walletResponseContract = z
	.object({ ledger: z.array(ledgerEntrySchema), wallet: creditWalletSchema })
	.catchall(z.json()) satisfies z.ZodType<WalletResponse>;

const usageBreakdownRowSchema = z
	.object({
		amountMicroUsd: z.number(),
		count: z.number(),
		key: z.union([z.string(), z.null()]),
	})
	.catchall(z.json()) satisfies z.ZodType<UsageBreakdownRow>;

const usageStatsSchema = z
	.object({
		byModel: z.array(usageBreakdownRowSchema),
		byProvider: z.array(usageBreakdownRowSchema),
		byReason: z.array(usageBreakdownRowSchema),
		creditedMicroUsd: z.number(),
		durationMs: z.number(),
		inputTokens: z.number(),
		outputTokens: z.number(),
		spentMicroUsd: z.number(),
		transactions: z.number(),
	})
	.catchall(z.json()) satisfies z.ZodType<UsageStats>;

const usageResponseContract = z
	.object({
		entries: z.array(ledgerEntrySchema),
		nextCursor: z.union([z.string(), z.null()]),
		stats: usageStatsSchema,
	})
	.catchall(z.json()) satisfies z.ZodType<UsageResponse>;

const topupQuoteSchema = z
	.object({
		chargeCents: z.number(),
		faceCents: z.number(),
		feeCents: z.number(),
	})
	.catchall(z.json()) satisfies z.ZodType<TopupQuote>;

/** Pure owner contracts preserve original transport metadata and own JSON keys. */
function creditResponseSchema<T>(contract: z.ZodType<T>) {
	return z.custom<T>(
		(value) =>
			rpcJsonResponseSchema.safeParse(value).success &&
			contract.safeParse(value).success
	);
}
export const walletUpdateSchema = creditResponseSchema(
	z
		.object({
			availableMicroUsd: z.number().optional(),
			balanceMicroUsd: z.number(),
			currency: z.string(),
			heldMicroUsd: z.number().optional(),
			id: z.string(),
			ownerId: z.string(),
			updatedAt: z.string(),
		})
		.catchall(z.json()) satisfies z.ZodType<WalletUpdate>
);
export const creditAlertEventSchema = creditResponseSchema(
	z
		.object({
			balanceMicroUsd: z.number(),
			createdAt: z.string(),
			level: z.literal("warning"),
			thresholdMicroUsd: z.number(),
			title: z.string(),
		})
		.catchall(z.json()) satisfies z.ZodType<CreditAlertEvent>
);
export const walletResponseSchema = creditResponseSchema(
	walletResponseContract
);
export const usageResponseSchema = creditResponseSchema(usageResponseContract);
export const topupCheckoutSchema = creditResponseSchema(
	z.object({ url: z.string().nullish(), quote: topupQuoteSchema.nullish() })
);
export const creditsErrorWireSchema = creditResponseSchema(
	z.object({ message: z.json().optional(), error: z.json().optional() })
);
export const creditsSettingsWireSchema = creditResponseSchema(
	z.object({ settings: z.json().optional() })
);

const numericSetting = z.number().catch(0);
const nullableTextSetting = z.string().nullable().catch(null);
const autoTopupSettingsContract = z.object({
	amountCents: numericSetting,
	consecutiveFailures: numericSetting,
	cooldownSec: numericSetting,
	enabled: z.json().optional().transform(Boolean),
	lastAttemptAt: nullableTextSetting,
	lastError: nullableTextSetting,
	monthChargedMicroUsd: numericSetting,
	monthKey: nullableTextSetting,
	monthlyCapCents: numericSetting,
	thresholdCents: numericSetting,
}) satisfies z.ZodType<AutoTopupSettings>;
const alertSettingsContract = z.object({
	recipients: z.enum(["none", "owners", "owners_admins"]).catch("none"),
	thresholdCents: numericSetting,
	notifiedAt: nullableTextSetting,
	belowSince: nullableTextSetting,
	lastError: nullableTextSetting,
}) satisfies z.ZodType<CreditAlertSettings>;

// Existing legacy settings normalization treats arrays as empty field maps,
// and missing/scalar settings as unset. The object branch keeps each original
// per-field fallback rather than replacing malformed fields with invented data.
export const autoTopupSettingsSchema = z.union([
	autoTopupSettingsContract,
	z.array(z.json()).transform(() => autoTopupSettingsContract.parse({})),
	z
		.json()
		.optional()
		.transform(() => null),
]);
export const creditAlertSettingsSchema = z.union([
	alertSettingsContract,
	z.array(z.json()).transform(() => alertSettingsContract.parse({})),
	z
		.json()
		.optional()
		.transform(() => null),
]);
