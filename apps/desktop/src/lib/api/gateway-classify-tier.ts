import type { GatewayFirewallPolicy } from "@ryuhq/core-client/gateway.ts";
import { type ApiTarget, request } from "./client.ts";
import type { InspectorMode } from "./gateway-routing-config.ts";
import { fetchClassifyWeightsPresentResponseSchema } from "./gateway-status-response-contracts.ts";

// ── Local classify tier ───────────────────────────────────────────────────────
//
// Core runs a lazy `llama.cpp` sidecar dedicated to classification-shaped work
// (guardrail inspection, smart-routing rule picking, LLM-judge evaluators) so
// those cheap per-turn calls never contend with Chat or burn a paid
// provider's tokens. The gateway exposes it as the `classify` provider, and the
// router's builtin prefix table maps the `gemma-3-270m` model prefix onto it.
//
// The desktop binds no port of its own to that tier. All it needs is to (a) name
// the sidecar when reading `/api/sidecar/status`, (b) offer the model id as a
// picker value, and (c) ask whether the tier can actually SERVE right now — two
// independent facts (a registered process manager, and a weights file on disk)
// which the derivation below folds into one {@link ClassifyTierState}. All of it
// lives here, beside the config types whose model fields consume it, rather than
// in a new module.

/**
 * Name of the Core sidecar serving the local classify tier — mirrors its Rust
 * `Sidecar::name()`, which is the key `/api/sidecar/status` reports it under.
 * The sidecar is LAZY (deliberately absent from Core's `startup_order`):
 * "registered but not running" is its normal resting state, not a fault — which
 * is why this key alone cannot report the tier's health, and
 * {@link deriveClassifyTierState} crosses it with a weights probe to tell a lazy
 * idle apart from a sidecar that can never start.
 */
export const CLASSIFY_SIDECAR_NAME = "llamacpp-classify";

/**
 * Model id of the local classify tier (Gemma 3 270M, QAT Q4_0). Routable
 * through the gateway because the router maps the `gemma-3-270m` prefix to the
 * `classify` provider — see the ORDER-IS-LOAD-BEARING note in
 * `crates/gateway/router/src/lib.rs`, which keeps that prefix above the generic
 * `gemma` → `local` row. Legal value for any "cheap model" field
 * (`inspector.model`, `smart_routing.classifier_model`), and the gateway's own
 * `DEFAULT_INSPECTOR_MODEL` — which is the gateway's COMPILE-TIME fallback: a
 * Core-spawned gateway prefers the id Core publishes as `RYU_CLASSIFY_MODEL_ID`
 * (`classify_model_id()`), and that is the one seam this constant cannot follow.
 * See the KNOWN LIMIT on {@link fetchClassifyWeightsPresent}.
 */
export const CLASSIFY_MODEL_ID = "gemma-3-270m-it-qat-Q4_0";

/**
 * The router's builtin model prefix for the classify provider. Any model id
 * starting with this is served by the local classify sidecar and by nothing
 * else, which is what lets a client ask "will this model need the local tier?"
 * without enumerating quant variants.
 */
export const CLASSIFY_MODEL_PREFIX = "gemma-3-270m";

/**
 * Live state of the local classify tier on one node.
 *
 * - `unknown` — nothing has answered yet (or a probe failed, e.g. an older Core
 *   without `/api/models/installed`). Renders as nothing: an unreachable node
 *   already says so elsewhere, and guessing "broken" would flash a false alarm
 *   on every dialog open.
 * - `absent` — Core answered `/api/sidecar/status` but does not register the
 *   sidecar at all. Current Core registers the manager unconditionally
 *   (`apps/core/src/main.rs`) and `SidecarManager::statuses` deliberately emits
 *   every registered sidecar that is NOT in `startup_order`, so the key is
 *   always present there — this variant only reaches an older Core (or a build
 *   without the manager), which is exactly the node where the tier genuinely
 *   does not exist.
 * - `unweighted` — the sidecar is registered but its GGUF is not on disk, so it
 *   CANNOT start: `classify.rs` bails "classifier model not found" at
 *   `weight_path().exists()` and logs it at `debug`. This is the live failure the
 *   whole status row exists for, because the onboarding download that fetches
 *   those weights is deliberately non-fatal (`install_local_stack` records a
 *   warning and moves on), so a node can sit here indefinitely while every other
 *   signal reads healthy.
 * - `idle` — registered, weights present, no resident process. The NORMAL resting
 *   state: the sidecar is lazy (deliberately not in `startup_order`) and starts
 *   on the first classification, so `idle` must never read as broken.
 * - `running` — holding a resident process right now.
 */
export type ClassifyTierState =
	| "absent"
	| "idle"
	| "running"
	| "unknown"
	| "unweighted";

/**
 * Fold the two independent probes into a {@link ClassifyTierState}.
 *
 * `undefined` means "not answered / probe failed" for BOTH inputs, and the whole
 * sidecar map is taken rather than one pre-read boolean on purpose: a bare
 * `running: boolean | undefined` cannot distinguish "Core says the sidecar isn't
 * registered" from "the status call hasn't answered", and collapsing those two
 * into `absent` is precisely the kind of confident-but-wrong claim this state
 * machine exists to prevent. Taking the map makes the distinction unfakeable.
 *
 * Order is load-bearing:
 *
 *  1. no status ⇒ `unknown`.
 *  2. status without our key ⇒ `absent` — the weights are irrelevant on a Core
 *     that cannot serve them.
 *  3. `running` ⇒ `running` WITHOUT consulting the weights probe. A resident
 *     process proves the weights exist (the start path bails otherwise), so a
 *     transient failure of the weights endpoint must not downgrade a
 *     demonstrably-working tier.
 *  4. otherwise the weights decide, and an unresolved probe is `unknown` rather
 *     than either happy answer.
 */
export function deriveClassifyTierState({
	sidecarStatus,
	weightsPresent,
}: {
	/** `/api/sidecar/status` as a name→running map; `undefined` = unanswered. */
	sidecarStatus: Record<string, boolean> | undefined;
	/** {@link fetchClassifyWeightsPresent}; `undefined` = unanswered/failed. */
	weightsPresent: boolean | undefined;
}): ClassifyTierState {
	if (sidecarStatus === undefined) {
		return "unknown";
	}
	const running = sidecarStatus[CLASSIFY_SIDECAR_NAME];
	if (running === undefined) {
		return "absent";
	}
	if (running) {
		return "running";
	}
	if (weightsPresent === undefined) {
		return "unknown";
	}
	return weightsPresent ? "idle" : "unweighted";
}

/**
 * Whether the tier can serve a classification on this node. `false` for both
 * failure states AND for `unknown`, so nothing offers the tier's model id as a
 * one-click value before the node has confirmed it can honour it.
 */
export function classifyTierServable(state: ClassifyTierState): boolean {
	return state === "idle" || state === "running";
}

/**
 * Whether a configured "cheap model" value points at the local classify tier on
 * a node that is KNOWN not to serve it — the shared gate for the two cards that
 * warn about it. `unknown` deliberately does not qualify: an unanswered probe
 * must not raise an alarm.
 *
 * The check is a property of the node crossed with the model id, and nothing
 * else in either card can reveal it: both consumers fail OPEN by design (the
 * inspector treats an errored inspection as not-flagged; smart routing keeps the
 * originally requested model), so the UI would otherwise report a guardrail that
 * is on, shows `Block`, and allows every turn.
 */
export function classifyTierCannotServeModel(
	state: ClassifyTierState,
	model: string
): boolean {
	if (state !== "absent" && state !== "unweighted") {
		return false;
	}
	return model.trim().startsWith(CLASSIFY_MODEL_PREFIX);
}

/**
 * Badge + hint for every resolvable tier state, plus — for the two states that
 * cannot serve — the `reason` clause each card composes its own consequence
 * onto (the inspector allows the turn; smart routing keeps the requested model).
 */
export const CLASSIFY_TIER_COPY = {
	running: {
		reason: undefined,
		badge: "Local classifier running",
		hint: "Gemma 3 270M is loaded on this node — classification costs nothing and leaves no data.",
	},
	idle: {
		reason: undefined,
		badge: "Local classifier ready",
		hint: "Gemma 3 270M is downloaded on this node; it starts on the first classification.",
	},
	unweighted: {
		badge: "Local classifier not downloaded",
		// Says "the weights this node's Core defaults to" rather than "the weights",
		// because that is exactly what the probe measured: an operator who pointed
		// the registry at a different id has other weights we cannot see.
		//
		// It used to end "…so it can never start", and both halves of that were
		// wrong: it overstated a recoverable state AND withheld the one-step remedy.
		// Core's boot spawns `install_local_stack` UNCONDITIONALLY
		// (apps/core/src/main.rs, the "Auto-install the local inference stack" block)
		// and that routine re-attempts the classifier GGUF every time
		// (apps/core/src/sidecar/onboarding.rs — the `classifier_gguf_installed`
		// step), so a restart genuinely retries the download. "Usually" is
		// load-bearing and not hedging: that step is gated on the llama.cpp BINARY
		// having installed, and a download that keeps failing is failing for a reason
		// (network, disk, a bad mirror) that only Core's log can name — so the copy
		// promises a retry, never a fix.
		hint: "This node registers the classify sidecar but not the Gemma 3 270M weights its Core defaults to, so it cannot start yet. Core retries the download every time it starts, so restarting Core is usually enough; if it keeps failing, Core's log says why.",
		// Stays a mid-sentence CLAUSE: both cards compose their own consequence onto
		// it ("…, but {reason} — so the call will fail…"), so it cannot grow a second
		// sentence. The remedy therefore lives in `hint`, which
		// `ClassifyTierNote` renders on both cards beside the badge.
		reason:
			"this node has not finished downloading the classifier weights (Gemma 3 270M) yet",
	},
	absent: {
		badge: "No local classifier",
		hint: "This node's Core does not provide the local classify tier — pick a hosted model instead.",
		reason: "this node's Core does not provide that tier",
	},
} satisfies Record<
	Exclude<ClassifyTierState, "unknown">,
	{ badge: string; hint: string; reason?: string }
>;

/**
 * Whether the classify tier's WEIGHTS are on this node's disk.
 *
 * Reads Core's `/api/models/installed`, whose `load_present()` drops any record
 * whose file is gone — the same `~/.ryu/models/<stem>.gguf` existence check
 * `classify.rs` bails on, so this answers exactly the question "will the sidecar
 * start?". Matched on the EXACT id, never the prefix: a user who installs
 * another `gemma-3-270m` quant as a chat model would otherwise make this report
 * ready while the sidecar still bails on the missing default quant.
 *
 * A Core endpoint in the gateway client because it exists solely to judge the
 * gateway's two "cheap model" fields. Deliberately not `listInstalledModels`
 * from `./models.ts`: that one returns `[]` on any error by design, and an empty
 * list is indistinguishable from "the endpoint is missing" — which would render
 * an older Core as a hard "weights missing" alarm. This one THROWS so the caller
 * can stay `unknown`.
 *
 * KNOWN LIMIT: an operator who overrides Core's registry id
 * (`RYU_LOCAL_CLASSIFIER_MODEL_ID`, republished to the gateway as
 * `RYU_CLASSIFY_MODEL_ID`) serves a different stem, and this probe would report
 * its own default missing. There is no Core route that publishes the resolved
 * registry id, and the gateway config cannot stand in for one: the exact
 * `<classify id>` → `classify` row `seed_classify_route` inserts is DERIVED, and the
 * gateway strips it from everything that leaves the process — both `GET /v1/config`
 * and its own `save()`, via `GatewayConfig::without_derived_values`
 * (apps/gateway/src/config.rs). So a served `routing.model_map` carries a classify
 * mapping only when an operator hand-wrote one, and reading it would report either
 * nothing or that operator's possibly-superseded alias as "current" — and calling a
 * tier ready that cannot start is the exact failure this probe exists to catch. So
 * the limit is
 * accepted in the pessimistic direction: an overridden node shows a "not
 * downloaded" badge it does not deserve. It stays a badge and not a warning unless
 * the override is to another quant of the SAME model, since
 * {@link classifyTierCannotServeModel} only judges ids under
 * {@link CLASSIFY_MODEL_PREFIX} and a coherent override points both the registry
 * and the config at an id outside it.
 */
export async function fetchClassifyWeightsPresent(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<boolean> {
	const json = await request<{ models?: { stem?: string }[] }>(
		target,
		"/api/models/installed",
		{ signal },
		fetchClassifyWeightsPresentResponseSchema
	);
	return (json.models ?? []).some((m) => m.stem === CLASSIFY_MODEL_ID);
}

/**
 * The swappable cheap-LLM traffic inspector (mirrors gateway `InspectorConfig`).
 * A detection *method* orthogonal to `policy` (the *action*). Opt-in and
 * fail-open.
 */
export interface InspectorConfig {
	/** Action taken when the inspector flags a turn (reuses the firewall policy). */
	action: GatewayFirewallPolicy;
	/** Master switch. Off by default (adds a per-turn model round-trip). */
	enabled: boolean;
	/** Skip inspection for turns shorter than this many characters. */
	min_chars: number;
	/** What the inspector looks for. */
	mode: InspectorMode;
	/**
	 * Model id used for inspection, resolved through the gateway router so it
	 * stays swappable.
	 *
	 * A blank value is NOT harmless, and the earlier claim here ("never
	 * meaningfully empty") was the round-2 mistake this doc now exists to prevent.
	 * The gateway does resolve a blank to {@link CLASSIFY_MODEL_ID} at
	 * DESERIALIZATION (`de_inspector_model`, apps/gateway/src/config.rs) — but that
	 * runs in the GATEWAY process, strictly downstream of a save. A desktop save
	 * goes to Core's `PUT /api/gateway/config`, and Core inspects the raw JSON body
	 * on the way through (`gateway_put_config` → `push_config` →
	 * `maybe_start_classify_tier`, apps/core/src/sidecar/gateway.rs) to decide
	 * whether to start the `llamacpp-classify` sidecar the classify id routes to.
	 * That predicate USED to return false for an empty model, so a blank on the wire
	 * meant "do not start the local classifier" — after which the gateway resolved
	 * the blank to that very classifier and called a provider nothing was listening
	 * on, and the inspector failed open. Core now treats blank-and-enabled as a
	 * selection as well (`inspector_model_resolves_to_tier`, inside
	 * `patch_selects_classify_tier` — a deliberate mirror of `de_inspector_model` on
	 * Core's side of the process boundary), so a blank is no longer silently fatal
	 * against a CURRENT Core.
	 *
	 * {@link withResolvedInspectorModels} still writes a concrete id on every save,
	 * for the two reasons that outlive that fix: `PUT /api/gateway/config` is a
	 * generic proxy, so the Core on the far side is whatever version the node runs
	 * (an older one still declines a blank), and what gets persisted should equal
	 * what the card displays. Neither half is redundant — Core's covers every other
	 * client of that proxy, this one covers every Core version.
	 */
	model: string;
	/** Per-inspection timeout in milliseconds; on timeout the request is allowed. */
	timeout_ms: number;
}

/**
 * Default (disabled) inspector config used when the gateway omits one.
 *
 * MIRRORS `impl Default for InspectorConfig` (apps/gateway/src/config.rs). Two
 * fields drifted from it and both drifts were silent:
 *
 * - `action` said `warn_and_continue`; the Rust default is `FirewallPolicy`'s
 *   `#[default]`, which is `Block` — an injection match is not meaningfully
 *   redactable, so blocking is the only action that actually stops it. A mirror
 *   that is strictly WEAKER than the enforced default is the dangerous
 *   direction to drift in.
 * - `model` said `""`. That used to match Rust, but the gateway now defaults it
 *   to the classify-tier classifier (and resolves a blank back to it as it reads
 *   the wire, in its OWN process — which is downstream of Core's start decision, so
 *   the gateway's resolution ALONE never made a blank safe to send; see
 *   {@link InspectorConfig.model} for which half of that is fixed where),
 *   precisely so that "inspector enabled" cannot mean "inspector silently never
 *   runs".
 *
 * Both were inert while the gateway always serializes `inspector` — the `??`
 * fallbacks in `normalizeConfig` and `InspectorCard` never fired — which is
 * exactly why they went unnoticed; the first response that omits the section
 * would have shown, and then saved back, the wrong values.
 */
export const DEFAULT_INSPECTOR: InspectorConfig = {
	enabled: false,
	model: CLASSIFY_MODEL_ID,
	mode: "both",
	min_chars: 40,
	timeout_ms: 1500,
	action: "block",
};

/**
 * The canonical serde field names a scope may freeze via `locked_fields`. A
 * locked field cannot be loosened by a narrower scope (node → org → agent); the
 * resolver keeps the stricter value. Mirrors the gateway's canonical list.
 */
export type LockableFirewallField =
	| "enabled"
	| "scan_inbound"
	| "scan_outbound"
	| "policy"
	| "log_detections"
	| "redact_pii"
	| "redact_secrets"
	| "wrap_untrusted_tool_results"
	| "inspector";
