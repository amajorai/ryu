/**
 * Credit-pool catalog: the single source of truth for the SEGREGATED inference
 * credit pools a grant may be restricted to.
 *
 * CLAUDE.md placement rule (§1): "what is allowed, shared, measured, or paid
 * for" is control-plane, so this sits beside {@link file://./plans.ts} in
 * `@ryu/auth` — plans decide what a subscriber is entitled to, pools decide
 * WHICH SUPPLY a granted dollar may be spent against.
 *
 * WHY POOLS EXIST AT ALL (the invariant everything below serves): Ryu is
 * running on provider credit Ryu holds directly — $100,000 of Microsoft Azure
 * startup credit (the default free pool), a $10,000 AWS Bedrock
 * allowance for frontier models, a $10,000 Cloudflare Workers AI allowance for
 * open models, $2,500 of Google Cloud Vertex AI, $1,000 of OpenAI, and $3,000
 * on Ryu's own Anthropic account. A dollar of Cloudflare buys
 * roughly 10–20× the tokens a dollar of
 * Bedrock does, each allowance has its OWN ceiling, and each burns down against
 * its OWN donor accounting. A blended ledger therefore cannot answer the one
 * question that matters operationally — "how much Bedrock is left?" — and a
 * blended WALLET would let a $50 Bedrock grant be spent on Cloudflare traffic,
 * silently converting cheap supply into expensive supply. So a grant carries
 * the pool that issued it and a debit carries the pool that SERVED it.
 *
 * SEPARATE POOLS: a grant pays only for requests served from its own pool
 * ({@link grantPoolsForServingPool}), never for the retail pass-through or BYOK
 * (see `debitWallet` in `@ryu/api/lib/credits`). A campaign therefore chooses
 * which supplier funds it, and issuance is capped by that pool's own ceiling
 * (`reservePoolBudget`). Users still see one "Ryu Credits" balance.
 *
 * USERS NEVER SEE A PROVIDER. The wallet is denominated in one Ryu-native unit
 * ("Ryu Credits"); {@link CreditPool.label} is the only name a user reads, and
 * it names a SPEED/CAPABILITY tier ("Ryu Fast" / "Ryu Frontier"), never a
 * vendor. Swapping the supplier behind a pool must not change what anyone was
 * promised.
 */

/**
 * The pool identifiers. These strings are DURABLE: they are written into
 * `CreditGrant.pool`, `CreditLedger.pool` and `CreditCampaign.pool` rows, and
 * they travel to the gateway verbatim as map KEYS (a `HashMap<String, i64>` of
 * per-pool budgets — serde's `rename_all = "camelCase"` renames struct fields,
 * NOT map keys). Renaming one is a data migration plus a gateway change, not an
 * edit here.
 */
export const CREDIT_POOL_IDS = [
	// FIRST ON PURPOSE: catalog order is the tie-break when the gateway picks a
	// pool for `openrouter/auto`, and the first visible pool is the admin
	// default. Ryu's Azure startup credit is the default free pool. Suffixed like
	// `openai-credits` so a future BYOK `azure` gateway slot stays untagged.
	"azure-credits",
	"cloudflare",
	"bedrock",
	"openrouter",
	"vertex",
	// NOT `openai`: that id is already taken on the gateway side by the
	// operator's OWN-KEY OpenAI provider (`config.openai` in
	// `apps/gateway/src/providers/mod.rs`, which `gpt-` / `o1` / `o3` / `o4` /
	// `text-davinci` route to). Attributing a node's own-key OpenAI traffic to
	// this donated allowance would burn the donation down for spend it never
	// paid for, so the donated supply gets its own registry slot and its own id.
	"openai-credits",
	// Same reasoning as `openai-credits`: `anthropic` is the gateway's BYOK slot,
	// so Ryu's own first-party Anthropic account gets a suffixed id.
	"anthropic-credits",
] as const;
export type CreditPoolId = (typeof CREDIT_POOL_IDS)[number];

/**
 * How a pool is positioned in the funnel. `free` is the cheap open-model supply
 * we can afford to give away (reach); `frontier` is the expensive supply we
 * spend to convert; `default` is the residual pass-through with no donated
 * allowance behind it; `retired` is a pool Ryu no longer serves or issues free
 * credit from, kept only because its id is stored on existing grants and
 * ledger rows (see {@link isFreeCreditPool}).
 */
export type CreditPoolTier = "free" | "frontier" | "default" | "retired";

/** One segregated supply of inference credit. */
export interface CreditPool {
	/**
	 * The donated allowance behind this pool, in micro-USD; `0` = uncapped (no
	 * donor ceiling, e.g. pass-through supply we pay for ourselves). This is the
	 * BURN-DOWN denominator for ops dashboards, not a per-user or per-wallet
	 * limit — nothing in the debit path reads it.
	 */
	readonly budgetCeilingMicroUsd: number;
	/** Operator-facing explanation of what supply this pool actually is. */
	readonly description: string;
	/**
	 * The gateway REGISTRY IDS whose traffic this pool bills for — the exact
	 * strings `provider.name()` returns in `apps/gateway/src/providers/mod.rs`.
	 * A near-miss string is silent: {@link poolForGatewayProvider} returns null
	 * and the request is attributed to no pool at all, so it never draws grant
	 * money and never appears in per-pool burn. Verify against the registry when
	 * adding one.
	 */
	readonly gatewayProviders: readonly string[];
	readonly id: CreditPoolId;
	/** The ONLY user-facing name for this pool. Names a tier, never a vendor. */
	readonly label: string;
	readonly tier: CreditPoolTier;
	/**
	 * Whether the pool is offered in user-facing pickers / campaign copy. A
	 * hidden pool still meters and still accepts grants — it is simply not
	 * something a user is ever asked to choose or is advertised credit in.
	 */
	readonly visible: boolean;
}

// One micro-USD is a millionth of a dollar; the unit the credit wallet stores.
// Duplicated from plans.ts's `usdToMicro` rather than imported, so this catalog
// stays a leaf module (it is imported by the gateway-facing resolve path, which
// must not drag in the Polar plan catalog).
const MICRO_USD_PER_USD = 1_000_000;
const usd = (dollars: number): number =>
	Math.round(dollars * MICRO_USD_PER_USD);

/**
 * The pool catalog. Ceilings are the provider allowances as granted; they are
 * documented here so the burn-down number has a denominator in one place.
 *
 * THESE ARE DEFAULTS FOR A FRESH DATABASE ONLY. `seedPoolBudgets`
 * (`@ryu/api/lib/campaigns`) writes `ceilingMicroUsd` with `$setOnInsert`,
 * because the STORED ROW is the authority — so on any database that has already
 * seeded, changing a figure here and redeploying changes NOTHING. A live
 * ceiling is changed with one operator write from the admin Credit pools page
 * (`PUT /api/campaigns/admin/pools/:pool`), no deploy needed.
 */
export const CREDIT_POOLS = {
	"azure-credits": {
		id: "azure-credits",
		label: "Ryu Standard",
		description:
			"Microsoft Azure (Azure OpenAI / AI Foundry) — Ryu's $100,000 Azure for Startups credit, served through the `azure-credits` gateway slot (Azure's OpenAI-compatible v1 endpoint). The credit covers ONLY models Azure sells and bills itself (Foundry’s Direct from Azure collection: OpenAI, DeepSeek, Llama, Grok, Kimi, Microsoft MAI and Azure-sold Cohere/Mistral); partner models such as Claude bill to the card, so they must never be linked to this slot. The DEFAULT free pool: sign-up, onboarding, quest, reward-store and referral grants land here.",
		gatewayProviders: ["azure-credits"],
		budgetCeilingMicroUsd: usd(100_000),
		tier: "free",
		visible: true,
	},
	cloudflare: {
		id: "cloudflare",
		label: "Ryu Fast",
		description:
			"Cloudflare Workers AI — open models (Llama, Mistral, …). Roughly 10–20× cheaper per token than the frontier pool, which is what makes it affordable to hand out for free.",
		gatewayProviders: ["cloudflare"],
		budgetCeilingMicroUsd: usd(10_000),
		tier: "free",
		visible: true,
	},
	bedrock: {
		id: "bedrock",
		label: "Ryu Frontier",
		description:
			"RETIRED. AWS Bedrock is no longer a free-credit pool: Ryu's AWS credit pays for its own VMs (the future self-hosted router service), not for free inference. The id stays because existing grants and ledger rows carry it; those grants still pay for Ryu's own supply (`isFreeCreditPool`). No gateway slot is attributed to it and no new grant may be issued against it.",
		gatewayProviders: [],
		budgetCeilingMicroUsd: usd(10_000),
		tier: "retired",
		visible: false,
	},
	openrouter: {
		id: "openrouter",
		label: "Ryu",
		description:
			"OpenRouter pass-through — no donated allowance behind it, so it is uncapped here and paid for out of ordinary top-up/subscription credit. Present so OpenRouter traffic is still ATTRIBUTABLE to a pool in burn dashboards; hidden because we never advertise grants against supply we buy at retail.",
		gatewayProviders: ["openrouter"],
		budgetCeilingMicroUsd: 0,
		tier: "default",
		visible: false,
	},
	vertex: {
		id: "vertex",
		label: "Ryu Vision",
		description:
			"Google Cloud Vertex AI — donated allowance for frontier multimodal models (Gemini, …). A SEPARATE gateway slot from `genai`, which is the AI Studio / Gemini API surface an operator points at their OWN key: same model family, different endpoint, different auth, and — the part that matters here — a different account to burn down.",
		gatewayProviders: ["vertex"],
		budgetCeilingMicroUsd: usd(2500),
		tier: "frontier",
		visible: true,
	},
	"openai-credits": {
		id: "openai-credits",
		label: "Ryu Reasoning",
		description:
			"OpenAI API — donated allowance for frontier reasoning models. Deliberately NOT the `openai` gateway id: that slot serves whatever key the node operator configured, so pooling it would burn this donation down for spend it never funded.",
		gatewayProviders: ["openai-credits"],
		budgetCeilingMicroUsd: usd(1000),
		tier: "frontier",
		visible: true,
	},
	"anthropic-credits": {
		id: "anthropic-credits",
		label: "Ryu Code",
		description:
			"Anthropic API on Ryu's own first-party account — frontier Claude models served directly, with no OpenRouter funding fee. Deliberately NOT the `anthropic` gateway id: that slot serves the node operator's own key, so pooling it would burn this allowance for spend it never funded.",
		gatewayProviders: ["anthropic-credits"],
		budgetCeilingMicroUsd: usd(3000),
		tier: "frontier",
		visible: true,
	},
} satisfies Record<CreditPoolId, CreditPool>;

/**
 * The pool free-credit grants land in unless a campaign says otherwise: Ryu's
 * Azure startup credit. Rewards, quests, onboarding and seeded campaigns read
 * this instead of naming a pool, so moving the default is a one-line change.
 */
export const DEFAULT_FREE_CREDIT_POOL: CreditPoolId = "azure-credits";

/** The catalog as a list, in {@link CREDIT_POOL_IDS} order. */
export const ALL_CREDIT_POOLS: readonly CreditPool[] = CREDIT_POOL_IDS.map(
	(id) => CREDIT_POOLS[id]
);

/**
 * Reverse index gateway registry id → pool, built ONCE at module load. The
 * debit path calls {@link poolForGatewayProvider} on every metered request, so
 * this must never be an O(pools × providers) scan per call.
 *
 * A provider id may belong to at most one pool — two pools claiming the same
 * provider would make attribution (and therefore burn-down) ambiguous, and the
 * ambiguity would only surface as money in the wrong bucket. We fail LOUDLY at
 * import time instead.
 */
const POOL_BY_GATEWAY_PROVIDER: ReadonlyMap<string, CreditPoolId> = (() => {
	const index = new Map<string, CreditPoolId>();
	for (const pool of ALL_CREDIT_POOLS) {
		for (const provider of pool.gatewayProviders) {
			const claimed = index.get(provider);
			if (claimed) {
				throw new Error(
					`credit pool "${pool.id}" claims gateway provider "${provider}" already claimed by "${claimed}"`
				);
			}
			index.set(provider, pool.id);
		}
	}
	return index;
})();

/**
 * The pool a gateway request bills against, from the provider that actually
 * served it (`provider.name()` at the gateway debit sites). `null` means "this
 * provider is not pool-attributed" — the debit then behaves exactly as it did
 * before pools existed: no grant is reachable, and the spend falls through to
 * the subscription and top-up buckets. That is the correct default for every
 * provider an operator has not tagged, and it is why adding a pool can never
 * retroactively change how existing traffic is billed.
 */
export const poolForGatewayProvider = (
	providerName: string
): CreditPoolId | null => POOL_BY_GATEWAY_PROVIDER.get(providerName) ?? null;

/**
 * Runtime guard for pool ids arriving over the wire (the internal debit
 * endpoint, campaign admin input, a gateway-supplied tag). Never trust a
 * request body to carry a valid pool: an unrecognized string that reached
 * `CreditGrant.pool` would create money no debit can ever spend.
 */
export const isCreditPoolId = (value: string): value is CreditPoolId =>
	Object.hasOwn(CREDIT_POOLS, value);

/**
 * Whether a pool is Ryu's OWN supply — a `free` or `frontier` pool (not the
 * retail OpenRouter pass-through, and not a `retired` pool). Mirrored by
 * `is_own_supply_pool` in `apps/gateway/src/credit_pools.rs`.
 */
export const isOwnSupplyPool = (pool: string | null | undefined): boolean =>
	typeof pool === "string" &&
	isCreditPoolId(pool) &&
	(CREDIT_POOLS[pool].tier === "free" ||
		CREDIT_POOLS[pool].tier === "frontier");

/**
 * Whether a grant of `pool` is free credit: an own-supply pool, or a `retired`
 * one whose already-issued grants still pay for Ryu's own supply. A retired
 * pool is never served from and never issues new grants.
 */
export const isFreeCreditPool = (pool: string | null | undefined): boolean =>
	isOwnSupplyPool(pool) ||
	(typeof pool === "string" &&
		isCreditPoolId(pool) &&
		CREDIT_POOLS[pool].tier === "retired");

/** The retired pools, whose already-issued grants still pay as free credit. */
export const RETIRED_POOL_IDS: readonly CreditPoolId[] = CREDIT_POOL_IDS.filter(
	(id) => CREDIT_POOLS[id].tier === "retired"
);

/**
 * SEPARATE POOLS: the grant pools a debit served from `servingPool` may draw.
 *
 * A grant pays only for traffic served from its OWN pool, because every supplier
 * covers different models on different terms (Azure's startup credit, for
 * one, pays only for models Azure bills directly). So own-supply traffic
 * served from pool P draws P's grants, plus the grants of a `retired` pool,
 * whose holders were promised free credit before their supplier was retired.
 * The retail pass-through draws only its own pool, and an unpooled debit (BYOK)
 * draws no grant at all. Mirrored by `grant_money_reachable_from` in
 * `apps/gateway/src/pipeline/credit_reserve.rs`.
 */
export const grantPoolsForServingPool = (
	servingPool: string | null | undefined
): readonly string[] => {
	if (!servingPool) {
		return [];
	}
	return isOwnSupplyPool(servingPool)
		? [servingPool, ...RETIRED_POOL_IDS]
		: [servingPool];
};

/** Whether new grants may be issued against `pool`. */
export const isIssuablePool = (pool: string): boolean =>
	isCreditPoolId(pool) && CREDIT_POOLS[pool].tier !== "retired";

/** The own-supply pools, in catalog order. */
export const OWN_SUPPLY_POOLS: readonly CreditPool[] = ALL_CREDIT_POOLS.filter(
	(pool) => isOwnSupplyPool(pool.id)
);
