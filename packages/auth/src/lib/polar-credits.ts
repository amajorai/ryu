import {
	CREDIT_POOL_IDS,
	CREDIT_POOLS,
	type CreditPoolId,
} from "./credit-pools.ts";

/** The aggregate Polar meter used for plan, top-up, and unrestricted usage. */
export const POLAR_MANAGED_CREDIT_EVENT = "ryu_managed_credit_v1";

/** The provider-specific meter event shared by the restricted pool meters. */
export const POLAR_RESTRICTED_CREDIT_EVENT = "ryu_restricted_credit_v1";

/**
 * Every donated/provider-specific pool gets its own Polar meter. The default
 * OpenRouter pool is intentionally excluded: it has no donated allocation and
 * belongs in the shared plan/top-up meter.
 */
export const POLAR_RESTRICTED_POOL_IDS = CREDIT_POOL_IDS.filter(
	(poolId) => CREDIT_POOLS[poolId].tier !== "default"
);

export function polarPoolMeterEnvKey(poolId: CreditPoolId): string {
	return `POLAR_METER_POOL_${poolId.replaceAll("-", "_").toUpperCase()}`;
}
