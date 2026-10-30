import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";
import {
	DEFAULT_GATEWAY_ACP,
	DEFAULT_GATEWAY_COMPUTER_USE,
	DEFAULT_SESSION_BUDGET,
	type GatewayConfig,
	type GatewayConfigPatch,
	type GatewayDoctorFixResult,
	type GatewayDoctorReport,
} from "./gateway-budget-config.ts";
import {
	CLASSIFY_MODEL_ID,
	DEFAULT_INSPECTOR,
	type InspectorConfig,
} from "./gateway-classify-tier.ts";
import { gatewayConfigResponseSchema } from "./gateway-config-schema.ts";
import type {
	GatewayFirewallConfig,
	GatewayFirewallOverlay,
} from "./gateway-evaluators.ts";
import { DEFAULT_ROUTING } from "./gateway-routing-helpers.ts";
import {
	gatewayDoctorFixResultResponseSchema,
	gatewayDoctorReportResponseSchema,
	updateGatewayConfigResponseSchema,
} from "./gateway-status-response-contracts.ts";

/**
 * Fetch the gateway's current config (redacted) via Core's proxy
 * (`/api/gateway/config`). Provider API keys are replaced with `"***"`.
 *
 * Rejects on Core-unreachable or gateway-down (502 relayed from Core).
 */
export async function fetchGatewayConfig(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<GatewayConfig> {
	const raw = await request(
		target,
		"/api/gateway/config",
		{
			signal,
		},
		gatewayConfigResponseSchema
	);
	const routing = raw.routing ?? DEFAULT_ROUTING;
	const budgets = raw.budgets ?? { users: {}, agents: {}, session: undefined };
	const acp = raw.acp ?? DEFAULT_GATEWAY_ACP;
	const computerUse = raw.computer_use ?? DEFAULT_GATEWAY_COMPUTER_USE;
	// Guard the shared path: a 2xx always carries `firewall`, but this function
	// backs several cards (budgets/keys/routing), so never let a missing section
	// throw and take them all down.
	const firewall: Partial<GatewayFirewallConfig> = raw.firewall ?? {};
	return {
		...raw,
		acp,
		computer_use: computerUse,
		budgets: {
			users: budgets.users ?? {},
			agents: budgets.agents ?? {},
			session: budgets.session ?? DEFAULT_SESSION_BUDGET,
		},
		// Passed through EXACTLY as served — no `smart_routing` (or `modality_map`,
		// or `eval_routing`) default folded in. Coalescing here would erase the
		// difference between "the gateway does not serve this section" and "it
		// serves it, switched off", and because the PUT replaces `routing`
		// wholesale the manufactured section rides back out on the next save of
		// anything else in the card. See {@link routingViewIncludesSmartRouting};
		// consumers that need a value to bind a control to coalesce at their own
		// edge, where they can also say which state they are in.
		routing,
		firewall: {
			...firewall,
			// Coalesced for the same reason as the three below: the guardrails card
			// binds a Select straight to this, and a `value={undefined}` Select renders
			// as an uncontrolled placeholder — which would then save an omitted tier.
			alert: firewall.alert ?? "silent",
			custom_patterns: firewall.custom_patterns ?? [],
			inspector: firewall.inspector ?? { ...DEFAULT_INSPECTOR },
			locked_fields: firewall.locked_fields ?? [],
		},
		firewall_org_overlays: raw.firewall_org_overlays ?? {},
		firewall_agent_overlays: raw.firewall_agent_overlays ?? {},
	};
}

/** Fetch the redacted Gateway + Core doctor report through Core's proxy. */
export async function fetchGatewayDoctor(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<GatewayDoctorReport> {
	return request<GatewayDoctorReport>(
		target,
		"/api/gateway/doctor",
		{
			signal,
		},
		gatewayDoctorReportResponseSchema
	);
}

/** Preview or apply Gateway-owned safe Doctor fixes through Core. */
export async function fixGatewayDoctor(
	target: ApiTarget,
	dryRun: boolean
): Promise<GatewayDoctorFixResult> {
	return request<GatewayDoctorFixResult>(
		target,
		"/api/gateway/doctor/fix",
		{
			body: { dryRun },
			method: "POST",
		},
		gatewayDoctorFixResultResponseSchema
	);
}

/**
 * Write a concrete id into any `inspector` whose `model` is blank/whitespace.
 *
 * Generic over the two shapes that carry an inspector — the node base
 * ({@link GatewayFirewallConfig}, `inspector?: InspectorConfig`) and an overlay
 * ({@link GatewayFirewallOverlay}, `inspector?: InspectorConfig | null`, where
 * `null` means "inherit, do not override"). A nullish inspector is returned
 * untouched, so "inherit" can never be turned into an override.
 *
 * Returns the SAME object when nothing needs changing; callers rely on identity to
 * avoid cloning a React draft that is already fine.
 *
 * `model` is typed `string`, but it is read defensively because this runs on a
 * transport path fed by whatever the gateway serialized: an inspector object
 * without the key would otherwise throw inside a save handler.
 */
function withResolvedInspectorModel<
	T extends { inspector?: Partial<InspectorConfig> | null },
>(section: T): T {
	const inspector = section.inspector;
	if (!inspector) {
		return section;
	}
	const parsedModel = z.string().safeParse(inspector.model);
	const model = parsedModel.success ? parsedModel.data.trim() : "";
	if (model !== "") {
		return section;
	}
	return { ...section, inspector: { ...inspector, model: CLASSIFY_MODEL_ID } };
}

/** {@link withResolvedInspectorModel} across one overlay store, identity-preserving. */
function withResolvedOverlayStore(
	store: Record<string, GatewayFirewallOverlay>
): Record<string, GatewayFirewallOverlay> {
	let changed = false;
	const next: Record<string, GatewayFirewallOverlay> = {};
	for (const [id, overlay] of Object.entries(store)) {
		const resolved = withResolvedInspectorModel(overlay);
		next[id] = resolved;
		changed ||= resolved !== overlay;
	}
	return changed ? next : store;
}

/**
 * Normalize a config patch so no `inspector.model` reaches the wire blank.
 *
 * WHY this is a transport concern and not a form concern. A blank model was never
 * the harmless "use the default" it reads as. The save travels desktop → Core
 * `PUT /api/gateway/config` → gateway `PUT /v1/config`, and Core reads the raw JSON
 * as it passes (`push_config` → `maybe_start_classify_tier` →
 * `patch_selects_classify_tier`, apps/core/src/sidecar/gateway.rs) to decide whether
 * to start `llamacpp-classify`. That predicate used to bail on an empty model, so a
 * blank meant "do not start the local classifier" — and THEN the gateway's
 * `de_inspector_model` resolved the same blank to the classify id and routed it at
 * the `classify` provider, whose port had nothing behind it. The inspector failed
 * open: the card said enabled, the action said Block, every turn was allowed. It
 * self-corrected only on a SECOND save, because that one carried the model the first
 * had persisted.
 *
 * Core's half of that bug is now fixed too (blank-and-enabled selects the tier), so
 * on a current node this function is NOT what makes the sidecar start. What it still
 * buys, and why it belongs on the transport rather than being deleted as redundant:
 * `PUT /api/gateway/config` is a generic authenticated proxy, so the Core on the far
 * side is whatever version that node runs — an older one still declines a blank —
 * and writing a concrete id keeps what is PERSISTED equal to what the card displays.
 * The two halves are deliberately asymmetric: Core's covers every other client of
 * that proxy, this one covers every Core version.
 *
 * The value written is {@link CLASSIFY_MODEL_ID}, which is byte-identical to what
 * the "Use it" button and {@link DEFAULT_INSPECTOR} already write, so this
 * introduces no divergence the UI did not already have — including the documented
 * KNOWN LIMIT on {@link fetchClassifyWeightsPresent} (a node whose registry id is
 * overridden resolves a different id inside the gateway; both ids still reach the
 * one `classify` provider via the router's builtin `gemma-3-270m` prefix).
 *
 * Overlay stores are normalized too, but for a NARROWER reason: Core's predicate
 * only ever reads `/firewall/inspector/model` at the top level, so an overlay-only
 * inspector never starts the sidecar regardless. Normalizing them keeps what is
 * persisted equal to what the card displays; it does not buy a sidecar start.
 *
 * Pure and exported for the tests: a patch with no firewall sections comes back
 * unchanged (by identity), and no input object is ever mutated — these patches are
 * React draft state.
 */
/** Legacy draft inputs may omit inspector fields before Gateway deserialization. */
export type GatewayConfigPatchInput = Omit<GatewayConfigPatch, "firewall"> & {
	firewall?: Omit<Partial<GatewayFirewallConfig>, "inspector"> & {
		inspector?: Partial<InspectorConfig>;
	};
};

export function withResolvedInspectorModels<T extends GatewayConfigPatchInput>(
	patch: T
): T {
	const firewall = patch.firewall
		? withResolvedInspectorModel(patch.firewall)
		: undefined;
	const orgOverlays = patch.firewall_org_overlays
		? withResolvedOverlayStore(patch.firewall_org_overlays)
		: undefined;
	const agentOverlays = patch.firewall_agent_overlays
		? withResolvedOverlayStore(patch.firewall_agent_overlays)
		: undefined;
	const changed =
		(firewall !== undefined && firewall !== patch.firewall) ||
		(orgOverlays !== undefined &&
			orgOverlays !== patch.firewall_org_overlays) ||
		(agentOverlays !== undefined &&
			agentOverlays !== patch.firewall_agent_overlays);
	if (!changed) {
		return patch;
	}
	const resolved = { ...patch };
	if (firewall) {
		resolved.firewall = firewall;
	}
	if (orgOverlays) {
		resolved.firewall_org_overlays = orgOverlays;
	}
	if (agentOverlays) {
		resolved.firewall_agent_overlays = agentOverlays;
	}
	return resolved;
}

/**
 * Apply a partial config change to the gateway via Core's proxy
 * (`PUT /api/gateway/config`). Core forwards the body to the gateway's
 * `PUT /v1/config`, which accepts firewall, budgets, auth, and routing. Provider
 * credentials are environment-variable-only and cannot be set here.
 *
 * "Forwards" is not "ignores": Core inspects the body first to lazily start the
 * classify sidecar, which is why every patch passes through
 * {@link withResolvedInspectorModels} here — the one seam every firewall save in
 * the app funnels into — rather than at each card's save handler.
 *
 * Rejects on Core-unreachable or a non-2xx relay from the gateway.
 */
export async function updateGatewayConfig(
	target: ApiTarget,
	patch: GatewayConfigPatch,
	signal?: AbortSignal
): Promise<{ ok: boolean }> {
	return request<{ ok: boolean }>(
		target,
		"/api/gateway/config",
		{
			method: "PUT",
			body: withResolvedInspectorModels(patch),
			signal,
		},
		updateGatewayConfigResponseSchema
	);
}
