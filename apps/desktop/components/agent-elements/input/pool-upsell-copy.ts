import type { CreditPool } from "@ryu/auth/lib/credit-pools";
import type { LiteralMessage } from "@ryu/i18n/react";

/**
 * Upsell copy for a pool row. Names the TIER and nothing else: the pool catalog's
 * standing rule is that a user never reads the name of the provider behind a pool,
 * so the supplier can be swapped without changing what anyone was promised.
 * There is no bring-your-own-key half: Ryu's pooled capacity is not something a
 * user can hold a key for, so offering one would be a dead end. The sentence is
 * one `tl()` message with the pool's (brand) name as `{pool}`.
 */
export function poolUpsellCopy(
	pool: Pick<CreditPool, "label">,
	tl: LiteralMessage
): { byoKey: null; upgrade: string } {
	return {
		upgrade: tl(
			"{pool} runs on Ryu's own capacity — included with a Ryu subscription, no API keys.",
			{ pool: pool.label }
		),
		byoKey: null,
	};
}
