/**
 * Ryu Cloud hosting — the FREE managed node tied to a qualifying hosted plan. This is NOT a
 * standalone subscription plan (see `plans.ts`): it provisions a Hetzner node
 * running Core + Gateway. Buying compute is buying infrastructure, not a feature
 * tier.
 *
 * Cloud instances are now FULLY DYNAMIC: the user browses the live Hetzner
 * catalog (all shared-vCPU types × locations) and pays `round(live × 2.5)` as an
 * ad-hoc Polar subscription price (see `packages/api/src/lib/hetzner-catalog.ts`
 * + `cloud-catalog.ts` + the single `POLAR_PRODUCT_CLOUD_INSTANCE` product). The
 * per-tier 2X/3X Polar products are RETIRED.
 *
 * All that remains here is the default EU BASE node definition — the cx23 (2
 * vCPU · 4 GB · 40 GB) profile. The hosted plan resolver selects the exact
 * plan- and region-specific shape (Pro cx23, Max cx33, Teams cx43, Business
 * cx53 in the default EU region) and grants it without a standalone Polar
 * product. Singapore keeps its available regional fallback shapes where the
 * EU CX types are not offered. The user
 * never sees the Hetzner/CX name on marketing surfaces — only CPU / RAM / SSD +
 * a perf label ("Cost-optimized").
 *
 * LIVE PRICING: the `monthlyUsd` here is `0` (free). Real prices + specs for paid
 * instances are fetched live from the Hetzner Cloud API with a 2.5× markup.
 */

/** The GPU inference backend a node provides. */
export type CloudGpuBackend = "none" | "modal";

/** A Ryu Cloud hosting node definition. */
export interface CloudTier {
	/** One-line positioning for the card. */
	readonly description: string;
	/** GPU inference backend: "none" = CPU-only on the node, "modal" = serverless GPU. */
	readonly gpuBackend: CloudGpuBackend;
	/** The Hetzner Cloud server type the node runs on. */
	readonly hetznerType: string;
	/** Stable id; the canonical node id (BASE). */
	readonly id: string;
	/** Included monthly AI usage credits (USD) attached to this hosted node. */
	readonly includedAiUsageUsd: number;
	/** True when the node ships free with the org's plan (BASE). */
	readonly includedWithMax: boolean;
	/** Customer-facing managed monthly price (USD). `0` for BASE (free with a plan). */
	readonly monthlyUsd: number;
	/** Display name. */
	readonly name: string;
	/** User-facing performance label ("Cost-optimized"). */
	readonly perfLabel: string;
	/** Marketing perk lines for the card (human specs only, no Hetzner names). */
	readonly perks: readonly string[];
}

/** The Hetzner server type backing the free BASE node. */
export const BASE_CLOUD_TYPE = "cx23";

/**
 * The default BASE managed node profile. Paid instances are no longer a fixed
 * ladder; they are picked dynamically from the live Hetzner
 * catalog and billed ad-hoc (see the module header).
 */
export const BASE_CLOUD_TIER: CloudTier = {
	id: "BASE",
	name: "Base",
	perfLabel: "Cost-optimized",
	hetznerType: BASE_CLOUD_TYPE,
	gpuBackend: "none",
	monthlyUsd: 0,
	includedWithMax: true,
	includedAiUsageUsd: 0,
	description: "A free managed node, included with your plan.",
	perks: [
		"Free with your plan · 2 vCPU · 4 GB · 40 GB",
		"Ryu Core + Gateway, fully hosted",
		"24/7 agents & automations",
		"Local models on the node's CPU",
	],
};

/**
 * Single-entry array shape so existing `find(...)` callers stay valid (paid
 * instances are dynamic now — see the module header).
 */
export const CLOUD_TIERS: readonly CloudTier[] = [BASE_CLOUD_TIER];
