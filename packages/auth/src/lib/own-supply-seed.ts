/**
 * The seed of the Ryu Router own-supply table: which Ryu Router
 * (OpenRouter-catalog) model ids Ryu can also serve from one of its OWN
 * provider accounts, and under which upstream id.
 *
 * The live table is control-plane data (`ownSupplyModels`, edited from the
 * admin "Ryu Router models" page, no deploy). This constant only seeds an EMPTY
 * collection on first boot, and it mirrors the compiled fallback the gateway
 * and Core keep for self-hosted / non-fleet use
 * (`SEED_OWN_SUPPLY_EQUIVALENTS` in `crates/gateway/router/src/lib.rs`). The
 * two are pinned together by `own-supply-seed.test.ts`.
 *
 * Slot and upstream values are SUPPLIER facts: they may appear on admin and
 * fleet surfaces only, never on a public, Core or user surface.
 */

export interface OwnSupplySeedRow {
	/**
	 * A row the gateway must prove callable (its local 1-token canary) before
	 * it routes there or the row is advertised as Free, even on a gateway that
	 * otherwise trusts the seed. Bedrock non-Claude rows: the Bedrock slot
	 * speaks Anthropic Messages, so they are expected to fail until a matching
	 * surface exists.
	 */
	readonly canaryRequired: boolean;
	/** The Ryu Router (OpenRouter) id the user picks. Lowercase. */
	readonly openrouterId: string;
	/** The own-supply gateway slot (a credit-pool gateway provider). */
	readonly slot: string;
	/** The id that slot's provider is sent. */
	readonly upstreamId: string;
}

/**
 * `anthropic/claude-3.5-sonnet` (Bedrock) was dropped: OpenRouter no longer
 * lists it, so a Free tag on it could never be picked.
 */
export const OWN_SUPPLY_SEED: readonly OwnSupplySeedRow[] = [
	{
		openrouterId: "anthropic/claude-opus-4.5",
		slot: "anthropic-credits",
		upstreamId: "claude-opus-4-5",
		canaryRequired: false,
	},
	{
		openrouterId: "anthropic/claude-sonnet-4.5",
		slot: "anthropic-credits",
		upstreamId: "claude-sonnet-4-5",
		canaryRequired: false,
	},
	{
		openrouterId: "anthropic/claude-haiku-4.5",
		slot: "anthropic-credits",
		upstreamId: "claude-haiku-4-5",
		canaryRequired: false,
	},
	{
		openrouterId: "amazon/nova-pro-v1",
		slot: "bedrock",
		upstreamId: "amazon.nova-pro-v1:0",
		canaryRequired: true,
	},
	{
		openrouterId: "meta-llama/llama-3.1-70b-instruct",
		slot: "bedrock",
		upstreamId: "meta.llama3-1-70b-instruct-v1:0",
		canaryRequired: true,
	},
	{
		openrouterId: "openai/gpt-5",
		slot: "openai-credits",
		upstreamId: "gpt-5",
		canaryRequired: false,
	},
	{
		openrouterId: "openai/o3",
		slot: "openai-credits",
		upstreamId: "o3",
		canaryRequired: false,
	},
	{
		openrouterId: "openai/o4-mini",
		slot: "openai-credits",
		upstreamId: "o4-mini",
		canaryRequired: false,
	},
	{
		openrouterId: "google/gemini-2.5-pro",
		slot: "vertex",
		upstreamId: "google/gemini-2.5-pro",
		canaryRequired: false,
	},
	{
		openrouterId: "google/gemini-2.5-flash",
		slot: "vertex",
		upstreamId: "google/gemini-2.5-flash",
		canaryRequired: false,
	},
	{
		openrouterId: "meta-llama/llama-3.1-8b-instruct",
		slot: "cloudflare",
		upstreamId: "@cf/meta/llama-3.1-8b-instruct",
		canaryRequired: false,
	},
];

/**
 * The model each own-supply pool serves `openrouter/auto` with when the
 * caller's free credit is mostly from that pool. Mirrors the compiled seed's
 * pool defaults (the slot's `…/standard` Ryu alias).
 */
export const OWN_SUPPLY_SEED_POOL_DEFAULTS: Readonly<Record<string, string>> = {
	"anthropic-credits": "anthropic/claude-sonnet-4.5",
	bedrock: "amazon/nova-pro-v1",
	cloudflare: "meta-llama/llama-3.1-8b-instruct",
	"openai-credits": "openai/o3",
	vertex: "google/gemini-2.5-flash",
};
