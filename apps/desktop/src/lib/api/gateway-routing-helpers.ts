import type { GatewayConfig } from "./gateway-budget-config.ts";
import type { Modality, ModalityMapping } from "./gateway-provider-config.ts";
import type { GatewayRoutingConfig } from "./gateway-routing-config.ts";

/**
 * The auto-routing pool: which models and providers automatic model routing may
 * pick. Both lists must match; an empty list does not constrain. The gateway's
 * global `smart_routing` pool is the ceiling and a per-agent pool
 * (`smart_routing.agent_pools`) can only narrow it.
 */
export interface RoutePool {
	allowed_models: string[];
	allowed_providers: string[];
}

/** Split a comma- or newline-separated pool field into trimmed, unique entries. */
export function parsePoolList(text: string): string[] {
	const entries = text
		.split(/[\n,]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return [...new Set(entries)];
}

/** Render a pool list back into its editable comma-separated form. */
export function formatPoolList(entries: readonly string[] | undefined): string {
	return (entries ?? []).join(", ");
}

/** Whether a pool constrains nothing. */
export function isOpenRoutePool(pool: RoutePool): boolean {
	return (
		pool.allowed_models.length === 0 && pool.allowed_providers.length === 0
	);
}

/**
 * Shape used only when a 2xx arrives with no `routing` section at all. It
 * deliberately omits `modality_map` / `eval_routing` / `smart_routing`: this
 * object stands in for "the gateway told us nothing", and manufacturing a
 * section here would assert something about the node that was never observed.
 *
 * `smart_routing` used to be listed here (and coalesced again in
 * {@link fetchGatewayConfig}), which contradicted the paragraph above and cost
 * the caller the one distinction that matters — see
 * {@link routingViewIncludesSmartRouting}.
 */
export const DEFAULT_ROUTING: GatewayRoutingConfig = {
	default_provider: "openai",
	model_map: {},
	fallback_chain: [],
};

/**
 * Whether this gateway's `GET /v1/config` actually reported `routing.modality_map`.
 *
 * Read this before offering a modality editor, and read the reason carefully —
 * it is not defensive typing.
 *
 * `PUT /v1/config { routing }` assigns the section wholesale
 * (`apps/gateway/src/api/config.rs`: `updated_config.routing = routing.clone()`)
 * and `RoutingConfig::modality_map` is `#[serde(default)]`. So a PUT body that
 * OMITS `modality_map` deserializes to an empty map and replaces whatever was on
 * disk — omission and `{}` erase identically. There is no clobber guard on
 * `routing` (the one documented on `custom_evaluators` does not cover it).
 *
 * Consequence: against a gateway old enough that its `RoutingView` has no
 * `modality_map` field, the desktop cannot round-trip what it cannot see, and
 * ANY routing save from this app wipes a hand-written `[routing.modality_map]`
 * in `gateway.toml`. That is the A7 defect, and on such a node it is not
 * fixable from here — only reportable. Hence a presence check rather than
 * `?? {}`: the two states demand different UI, and coalescing hides the one
 * that destroys data.
 *
 * A gateway that DOES serve the field always emits the key (an empty
 * `HashMap` serializes as `{}`), so presence is an exact test.
 */
export function routingViewIncludesModalityMap(
	routing: GatewayRoutingConfig
): boolean {
	return "modality_map" in routing;
}

/**
 * Whether this gateway's `GET /v1/config` actually reported
 * `routing.smart_routing`.
 *
 * The same presence test as {@link routingViewIncludesModalityMap}, and for the
 * same structural reason: `PUT /v1/config { routing }` assigns the section
 * wholesale and `RoutingConfig::smart_routing` is `#[serde(default)]`
 * (`apps/gateway/src/config.rs`), so a PUT body that omits it deserializes to
 * `SmartRoutingConfig::default()` and replaces whatever was on disk. Omission
 * and an explicit default erase identically; against a gateway too old to serve
 * the field this is not fixable from here, only reportable.
 *
 * ## Why it needed its own predicate rather than a `??` default
 *
 * `fetchGatewayConfig` used to coalesce the field to
 * {@link DEFAULT_SMART_ROUTING}, which is exactly the move the modality-map work
 * ruled out for itself. The coalesce is worse here than it is for
 * `modality_map`, not milder: an unserved map coalesces to `{}` (nothing
 * claimed), whereas an unserved `smart_routing` coalesces to a *concrete*
 * `enabled: false` — a fabricated "classifier routing is off" that the desktop
 * then spreads back on the next save of any other routing field. That is the
 * healthy-status-for-a-dead-thing shape inverted: the card reports a setting the
 * node never told it about, and saving something unrelated turns the operator's
 * hand-written `[routing.smart_routing]` off.
 *
 * A gateway that DOES serve the field always emits the key (`SmartRoutingConfig`
 * is a plain struct on `RoutingView`, not an `Option`), so presence is an exact
 * test.
 *
 * ## Consumed by `SmartRoutingCard` (`GatewayDialog.tsx`)
 *
 * The card keeps a three-state `served` (`null` = not loaded, so a healthy
 * gateway does not flash a data-loss warning during its first fetch). When it is
 * `false` the card disables every control and says on screen that the switch
 * reads off because nothing was reported, not because routing is off.
 *
 * `cfg.routing.smart_routing ?? DEFAULT_SMART_ROUTING` survives at the load edge
 * and that is deliberate: a Switch or Select bound to `undefined` goes
 * uncontrolled. It is a *rendering* stand-in only — `served` carries the truth,
 * and `handleSave` refuses on anything but `served === true`, re-testing this
 * predicate against the freshly re-fetched config (the gateway can restart, or be
 * swapped for an older build, between mount and save) rather than trusting the
 * flag from mount.
 */
export function routingViewIncludesSmartRouting(
	routing: GatewayRoutingConfig
): boolean {
	return "smart_routing" in routing;
}

/**
 * Read-modify-write one `routing.modality_map` row, returning the FULL routing
 * object to PUT.
 *
 * Spread-based on purpose. Because `put_config` replaces the routing section
 * wholesale, every sibling field — `eval_routing`, `smart_routing`,
 * `provider_tiers`, `model_map`, and anything a newer gateway serves that this
 * TS interface has not learned about yet — has to ride along untouched. Spread
 * carries unknown keys; an object literal built field-by-field would not, and
 * that is exactly how `modality_map` came to be erased in the first place.
 *
 * @param routing The routing object as returned by a FRESH `GET` (never a stale
 *   snapshot — the gateway persists routing without updating its startup
 *   snapshot, so an old read spreads old values back over the file).
 * @param modality Which row to author.
 * @param mapping `null` clears the row so the modality falls back to ordinary
 *   model routing. Otherwise the provider id, plus a model that is OMITTED when
 *   blank — `Some("")` would be forwarded to the provider as a literal empty
 *   model name (`router/src/lib.rs` only substitutes the caller's model for
 *   `None`), whereas an absent key means "forward the caller's own model".
 */
export function withModalityMapping(
	routing: GatewayRoutingConfig,
	modality: Modality,
	mapping: { model?: string; provider: string } | null
): GatewayRoutingConfig {
	const next: GatewayRoutingConfig["modality_map"] = {
		...routing.modality_map,
	};
	if (mapping === null) {
		delete next[modality];
	} else {
		const model = mapping.model?.trim() ?? "";
		const entry: ModalityMapping = { provider: mapping.provider.trim() };
		if (model) {
			entry.model = model;
		}
		next[modality] = entry;
	}
	return { ...routing, modality_map: next };
}

/**
 * Rebuild the routing card's draft-plus-Save edits onto a FRESH routing read.
 * `PUT /v1/config { routing }` replaces the whole section, and the card's draft
 * is loaded once, so sending it as-is would revert whatever another surface
 * saved in the meantime (Smart Routing, eval routing, cost tiers, model map).
 *
 * Only what the draft changed relative to `base` (the copy it was loaded from)
 * is applied: the default provider, the fallback chain, and individual provider
 * tiers. Everything else, including unknown future keys, comes from `fresh`.
 */
export function withRoutingDraftEdits(
	fresh: GatewayRoutingConfig,
	base: GatewayRoutingConfig,
	draft: GatewayRoutingConfig
): GatewayRoutingConfig {
	const next: GatewayRoutingConfig = { ...fresh };
	if (draft.default_provider !== base.default_provider) {
		next.default_provider = draft.default_provider;
	}
	const chainChanged =
		draft.fallback_chain.length !== base.fallback_chain.length ||
		draft.fallback_chain.some(
			(provider, index) => provider !== base.fallback_chain[index]
		);
	if (chainChanged) {
		next.fallback_chain = [...draft.fallback_chain];
	}
	const tierEdits = Object.entries(draft.provider_tiers ?? {}).filter(
		([provider, tier]) => base.provider_tiers?.[provider] !== tier
	);
	if (tierEdits.length > 0) {
		next.provider_tiers = {
			...fresh.provider_tiers,
			...Object.fromEntries(tierEdits),
		};
	}
	return next;
}

/** JSON with object keys sorted, so map order from the gateway never matters. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, inner: unknown) =>
		inner && typeof inner === "object" && !Array.isArray(inner)
			? Object.fromEntries(
					Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))
				)
			: inner
	);
}

/**
 * Whether `fresh` still holds the guardrail sections `base` was loaded with.
 * The Guardrails Save replaces `firewall` and both overlay stores wholesale, so
 * only a change to those is a real conflict for it. The config revision covers
 * the whole file and also moves for unrelated saves (a provider key, routing),
 * which must not throw away a guardrails draft.
 */
export function sameGuardrailSections(
	base: GatewayConfig,
	fresh: GatewayConfig
): boolean {
	return (
		canonicalJson([
			base.firewall,
			base.firewall_org_overlays,
			base.firewall_agent_overlays,
		]) ===
		canonicalJson([
			fresh.firewall,
			fresh.firewall_org_overlays,
			fresh.firewall_agent_overlays,
		])
	);
}
