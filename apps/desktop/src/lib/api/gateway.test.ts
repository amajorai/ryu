// apps/desktop/src/lib/api/gateway.test.ts
//
// Three kinds of test, all about the same failure mode — the UI claiming
// something the node does not do:
//
//  1. MIRROR tests. Several of this module's exports are copies of values whose
//     real definition lives in Rust, and a stale copy is silent: the UI shows one
//     thing and the gateway enforces another. These tests PARSE the Rust sources
//     (they are in this repo, reachable from the test's own directory) and compare
//     the TS constants against what they read. An earlier version of this file
//     compared the TS constants to TS literals and claimed to catch "someone
//     changed the Rust side"; it could not — every assertion passed no matter what
//     Rust said. Every helper below THROWS when its anchor is missing rather than
//     returning `undefined`, because an assertion of `undefined === undefined` is
//     how a guard like this dies quietly.
//
//  2. The classify-tier state machine, which decides whether the guardrail cards
//     say "ready" or "will not run". Its five states are the reason the derivation
//     lives in this module instead of inside the dialog component.
//
//  3. WIRE tests, over `withResolvedInspectorModels` — the save-path normalization
//     that keeps a blank `inspector.model` off the wire, because Core reads the
//     proxied body to decide whether to start the local classifier and the
//     gateway's blank-resolution happens a process too late to help. These assert
//     on the transport's own output, NOT on the current shape of Core's predicate:
//     that predicate is being widened in parallel, and pinning a test to its
//     present blank-rejection branch would go red for a sibling fix rather than a
//     regression. The cross-process dependency is stated in prose on the function.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type RyuJsonValue, rpcJsonResponseSchema } from "@ryu/app-host/rpc";
import { z } from "zod";
import type { GatewayConfigPatchInput, InspectorConfig } from "./gateway.ts";
import {
	ALERT_TIERS,
	buildBudgetRule,
	CLASSIFY_MODEL_ID,
	CLASSIFY_MODEL_PREFIX,
	CLASSIFY_SIDECAR_NAME,
	CLASSIFY_TIER_COPY,
	classifyTierCannotServeModel,
	classifyTierServable,
	configureGatewayProviderAccount,
	DEFAULT_GATEWAY_ACP,
	DEFAULT_GATEWAY_COMPUTER_USE,
	DEFAULT_INSPECTOR,
	DEFAULT_SESSION_BUDGET,
	DEFAULT_SMART_ROUTING,
	deriveClassifyTierState,
	fetchGatewayConfig,
	formatPoolList,
	type GatewayConfigPatch,
	type GatewayRoutingConfig,
	isOpenRoutePool,
	MODALITIES,
	parsePoolList,
	routingViewIncludesModalityMap,
	routingViewIncludesSmartRouting,
	runGatewayEvals,
	runGatewayRedTeam,
	SmartRoutingUnavailableError,
	sameGuardrailSections,
	saveAgentRouteOverride,
	saveAgentRoutePool,
	scoreGatewayOutput,
	updateGatewayConfig,
	withAgentBudget,
	withModalityMapping,
	withResolvedInspectorModels,
	withRoutingDraftEdits,
} from "./gateway.ts";

// src/lib/api → src/lib → src → apps/desktop → apps → repo root.
const REPO_ROOT = join(import.meta.dir, "../../../../..");

function rustSource(relative: string): string {
	const path = join(REPO_ROOT, relative);
	try {
		return readFileSync(path, "utf8");
	} catch (e) {
		throw new Error(
			`mirror test cannot read ${relative} (resolved ${path}): ${e instanceof Error ? e.message : e}`
		);
	}
}

const GATEWAY_CONFIG_RS = "apps/gateway/src/config.rs";
const ROUTER_RS = "crates/gateway/router/src/lib.rs";
const CLASSIFY_SIDECAR_RS =
	"apps/core/src/sidecar/providers/llamacpp/classify.rs";
// `AlertTier` lives in the neutral contracts crate, not in the gateway binary —
// it crosses stage boundaries (budget ↔ firewall ↔ pipeline), and Core mirrors it
// again in `policy_alerts`. The wire values a UI can offer are defined HERE.
const CONTRACTS_RS = "crates/gateway/contracts/src/lib.rs";
const BUDGET_RS = "crates/gateway/budget/src/lib.rs";
// Core's own re-declaration of `AlertTier`. Core does not depend on the gateway
// contracts crate, so the two enums are coupled only by their serde wire strings —
// and they are spelled with DIFFERENT rename rules (`lowercase` here vs
// `snake_case` there). The test below pins them equal.
const CORE_POLICY_ALERTS_RS = "apps/core/src/policy_alerts/mod.rs";

const gatewayConfigRs = rustSource(GATEWAY_CONFIG_RS);
const routerRs = rustSource(ROUTER_RS);
const classifySidecarRs = rustSource(CLASSIFY_SIDECAR_RS);
const contractsRs = rustSource(CONTRACTS_RS);
const budgetRs = rustSource(BUDGET_RS);
const corePolicyAlertsRs = rustSource(CORE_POLICY_ALERTS_RS);

/** Anchor a regex in a named file, or fail loudly naming both. */
function match(source: string, file: string, re: RegExp, what: string): string {
	const found = re.exec(source);
	if (!found?.[1]) {
		throw new Error(
			`mirror test could not find ${what} in ${file} (pattern ${re.source}) — the Rust side moved; update this test, not just the constant`
		);
	}
	return found[1];
}

/** `pub const NAME: &str = "value";` */
function rustStrConst(source: string, file: string, name: string): string {
	return match(
		source,
		file,
		new RegExp(`const ${name}: &str = "([^"]*)"`),
		`const ${name}`
	);
}

/** A zero-arg fn whose whole body is one integer literal. */
function rustIntFn(source: string, file: string, name: string): number {
	const raw = match(
		source,
		file,
		new RegExp(`fn ${name}\\(\\) -> \\w+ \\{\\s*(\\d+)\\s*\\}`),
		`fn ${name}`
	);
	return Number(raw);
}

/**
 * From the first line that starts with `header` up to the next `\n}` at column 0
 * — i.e. one item's body, which is all these mirrors need to read.
 */
function rustBlock(source: string, file: string, header: string): string {
	const start = source.indexOf(header);
	if (start < 0) {
		throw new Error(`mirror test could not find \`${header}\` in ${file}`);
	}
	const end = source.indexOf("\n}", start);
	if (end < 0) {
		throw new Error(`mirror test found \`${header}\` in ${file} but no end`);
	}
	return source.slice(start, end);
}

const CAMEL_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])/g;

/**
 * The wire value of an enum's `#[default]` variant. Also asserts the enum carries
 * `#[serde(rename_all = "snake_case")]`, because that attribute is the only
 * reason the TS union is `"warn_and_continue"` and not `"WarnAndContinue"` —
 * dropping it would change every wire value while leaving the variant names
 * untouched.
 */
function rustEnumDefaultWireValue(
	source: string,
	file: string,
	name: string
): string {
	const header = `pub enum ${name}`;
	const declStart = source.indexOf(header);
	if (declStart < 0) {
		throw new Error(`mirror test could not find \`${header}\` in ${file}`);
	}
	// Derive/serde attributes sit immediately above the declaration.
	const attrs = source.slice(Math.max(0, declStart - 400), declStart);
	if (!attrs.includes('#[serde(rename_all = "snake_case")]')) {
		throw new Error(
			`${name} in ${file} lost #[serde(rename_all = "snake_case")] — its wire values are no longer snake_case, so the TS union is wrong`
		);
	}
	const variant = match(
		rustBlock(source, file, header),
		file,
		/#\[default\]\s*(\w+)/,
		`#[default] variant of ${name}`
	);
	return variant.replace(CAMEL_BOUNDARY, "_").toLowerCase();
}

/** A bare `Variant,` line inside an enum body. */
const RUST_VARIANT_LINE = /^([A-Z]\w*),$/;

/**
 * An enum's variants as WIRE values, in declaration order, asserting the serde
 * casing attribute is the one the caller expects.
 *
 * Declaration order is the point for `AlertTier`: the Rust enum derives `Ord` from
 * it and the pipeline takes the `max` tier across every matched rule, so a TS list
 * in a different order would describe a different severity ladder. `rename_all` is
 * asserted for the same reason {@link rustEnumDefaultWireValue} asserts it — the
 * attribute is the ONLY reason the values are lowercase rather than the variant
 * names, and dropping it changes every wire value while leaving Rust compiling.
 */
function rustEnumWireVariants(
	source: string,
	file: string,
	name: string,
	renameAll: "lowercase" | "snake_case"
): string[] {
	const header = `pub enum ${name}`;
	const declStart = source.indexOf(header);
	if (declStart < 0) {
		throw new Error(`mirror test could not find \`${header}\` in ${file}`);
	}
	const attrs = source.slice(Math.max(0, declStart - 400), declStart);
	if (!attrs.includes(`#[serde(rename_all = "${renameAll}")]`)) {
		throw new Error(
			`${name} in ${file} does not carry #[serde(rename_all = "${renameAll}")] — its wire values are not what the TS union claims`
		);
	}
	const variants: string[] = [];
	for (const line of rustBlock(source, file, header).split("\n")) {
		const found = RUST_VARIANT_LINE.exec(line.trim());
		if (found?.[1]) {
			const variant = found[1];
			variants.push(
				renameAll === "lowercase"
					? variant.toLowerCase()
					: variant.replace(CAMEL_BOUNDARY, "_").toLowerCase()
			);
		}
	}
	if (variants.length === 0) {
		throw new Error(
			`mirror test parsed no variants out of \`${header}\` in ${file}`
		);
	}
	return variants;
}

/**
 * The declared type of `pub <field>: <type>` inside a struct body, or throw.
 * Used to prove a field the TS interface claims actually exists on the Rust
 * struct — a TS-only field is silently dropped by serde, which is the failure
 * this whole file exists to catch.
 */
function rustStructFieldType(
	source: string,
	file: string,
	struct: string,
	field: string
): string {
	const block = rustBlock(source, file, `pub struct ${struct}`);
	return match(
		block,
		file,
		new RegExp(`pub ${field}: ([^,\\n]+)`),
		`field \`${field}\` on \`${struct}\``
	);
}

/**
 * `impl Default for InspectorConfig`'s field initialisers, as `field → the Rust
 * expression it is set to`. Comment lines are skipped; nothing else is.
 */
function parseInspectorDefaultImpl() {
	const block = rustBlock(
		gatewayConfigRs,
		GATEWAY_CONFIG_RS,
		"impl Default for InspectorConfig"
	);
	const fields: Record<string, string> = {};
	for (const line of block.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("//")) {
			continue;
		}
		const found = /^(\w+):\s*(.+),$/.exec(trimmed);
		if (found?.[1] && found[2]) {
			fields[found[1]] = found[2];
		}
	}
	if (Object.keys(fields).length === 0) {
		throw new Error(
			`mirror test parsed no fields out of impl Default for InspectorConfig in ${GATEWAY_CONFIG_RS}`
		);
	}
	return fields;
}

/**
 * Resolve one field initialiser to the value it produces. Throws on anything it
 * has not been taught — a new default expression must be understood here before
 * this file can claim to mirror it, which is the whole point.
 */
function resolveRustDefault(expr: string): boolean | number | string {
	if (expr === "true" || expr === "false") {
		return expr === "true";
	}
	if (expr === "default_inspector_model()") {
		// `fn default_inspector_model()` → `classify_model_id()`, which prefers the
		// id Core publishes at runtime and falls back to this const. The desktop
		// cannot read the gateway's environment, so the compile-time fallback is
		// what a TS mirror can honestly claim.
		return rustStrConst(
			gatewayConfigRs,
			GATEWAY_CONFIG_RS,
			"DEFAULT_INSPECTOR_MODEL"
		);
	}
	if (expr === "default_inspector_min_chars()") {
		return rustIntFn(
			gatewayConfigRs,
			GATEWAY_CONFIG_RS,
			"default_inspector_min_chars"
		);
	}
	if (expr === "default_inspector_timeout_ms()") {
		return rustIntFn(
			gatewayConfigRs,
			GATEWAY_CONFIG_RS,
			"default_inspector_timeout_ms"
		);
	}
	const enumDefault = /^(\w+)::default\(\)$/.exec(expr);
	if (enumDefault?.[1]) {
		return rustEnumDefaultWireValue(
			gatewayConfigRs,
			GATEWAY_CONFIG_RS,
			enumDefault[1]
		);
	}
	throw new Error(
		`mirror test does not know how to resolve the Rust default \`${expr}\` — teach resolveRustDefault about it before trusting DEFAULT_INSPECTOR`
	);
}

/** `impl Default for InspectorConfig`, resolved to plain JSON values. */
function rustInspectorDefault() {
	const out: Record<string, boolean | number | string> = {};
	for (const [field, expr] of Object.entries(parseInspectorDefaultImpl())) {
		out[field] = resolveRustDefault(expr);
	}
	return out;
}

/** The `("<prefix>", "<provider>")` rows of `builtin_prefixes()`, in order. */
function routerBuiltinPrefixes(): [string, string][] {
	const block = rustBlock(routerRs, ROUTER_RS, "pub fn builtin_prefixes(");
	const rows = [...block.matchAll(/\("([^"]+)",\s*"([^"]+)"\)/g)].map((m) =>
		z.tuple([z.string(), z.string()]).parse([m[1], m[2]])
	);
	if (rows.length === 0) {
		throw new Error(
			`mirror test parsed no prefix rows out of builtin_prefixes() in ${ROUTER_RS}`
		);
	}
	return rows;
}

describe("DEFAULT_INSPECTOR mirrors the Rust default", () => {
	it("matches `impl Default for InspectorConfig` field for field", () => {
		// Read out of apps/gateway/src/config.rs at test time, so editing the Rust
		// default without editing this module turns red here. Widened to a plain
		// record because the Rust side is parsed text: it has no idea `mode` is a
		// three-value union, and pinning it to `InspectorConfig` would only assert
		// that the parser's OUTPUT type matches — not that the values do.
		const mirrored = {
			...DEFAULT_INSPECTOR,
		} satisfies Record<string, boolean | number | string>;
		expect(Object.entries(mirrored)).toEqual(
			Object.entries(rustInspectorDefault())
		);
	});

	it("covers exactly the fields the Rust struct initialises", () => {
		expect(Object.keys(DEFAULT_INSPECTOR).sort()).toEqual(
			Object.keys(parseInspectorDefaultImpl()).sort()
		);
	});

	it("defaults the flag action to block, not warn", () => {
		// `action` resolves to `FirewallPolicy::default()`, whose `#[default]` is
		// `Block`. A `warn_and_continue` mirror is strictly weaker than what the
		// gateway enforces, so if a fallback ever fires the UI would both
		// misreport AND save a downgrade.
		expect(DEFAULT_INSPECTOR.action).toBe("block");
		expect(
			rustEnumDefaultWireValue(
				gatewayConfigRs,
				GATEWAY_CONFIG_RS,
				"FirewallPolicy"
			)
		).toBe("block");
	});

	it("defaults the model to something that actually resolves", () => {
		// The empty-string default is what made "inspector enabled" mean
		// "inspector silently never runs": it routed to the default provider under
		// an empty model NAME, upstreams 400'd, and the inspector fails open. The
		// gateway now defaults (and resolves a blank) to the classify tier.
		expect(DEFAULT_INSPECTOR.model.trim()).not.toBe("");
	});

	it("keeps the gateway's blank-model resolution pointed at the classify tier", () => {
		// The doc on `InspectorConfig.model` promises a cleared box comes back as
		// the local classifier. That promise is `de_inspector_model`; if it stopped
		// calling the classify-tier resolver, clearing the box would again mean
		// "never runs" while this module kept telling the user otherwise.
		const de = rustBlock(
			gatewayConfigRs,
			GATEWAY_CONFIG_RS,
			"fn de_inspector_model"
		);
		expect(de).toContain("default_inspector_model()");
	});
});

describe("local classify tier mirrors Rust", () => {
	it("names the Core sidecar exactly as `Sidecar::name()` reports it", () => {
		// The key `/api/sidecar/status` reports the sidecar under.
		//
		// `name()`'s body is a literal OR a const reference — Rust grew its own
		// `CLASSIFY_SIDECAR_NAME` after this mirror shipped, and this test went red on
		// the parse (the VALUE never changed), which is the maintenance a real drift
		// guard costs. Both forms are followed rather than pinning one, so neither
		// direction of that refactor is a false alarm; anything else still throws.
		const body = match(
			classifySidecarRs,
			CLASSIFY_SIDECAR_RS,
			/fn name\(&self\) -> &'static str \{\s*([^\s};]+)/,
			"the classify sidecar's Sidecar::name()"
		);
		const name = body.startsWith('"')
			? (body.match(/^"([^"]+)"/)?.[1] ?? "")
			: rustStrConst(classifySidecarRs, CLASSIFY_SIDECAR_RS, body);
		expect(name).not.toBe("");
		expect(CLASSIFY_SIDECAR_NAME).toBe(name);
	});

	it("uses the model id the gateway itself defaults the inspector to", () => {
		expect(CLASSIFY_MODEL_ID).toBe(
			rustStrConst(
				gatewayConfigRs,
				GATEWAY_CONFIG_RS,
				"DEFAULT_INSPECTOR_MODEL"
			)
		);
	});

	it("uses the prefix the router maps to the `classify` provider", () => {
		const classifyRows = routerBuiltinPrefixes().filter(
			([, provider]) => provider === "classify"
		);
		expect(classifyRows.map(([prefix]) => prefix)).toEqual([
			CLASSIFY_MODEL_PREFIX,
		]);
		expect(CLASSIFY_MODEL_ID.startsWith(CLASSIFY_MODEL_PREFIX)).toBe(true);
	});

	it("keeps the prefix above the generic gemma row, so it stays narrower", () => {
		// `RoutingTables::route` takes the FIRST `starts_with` hit, not the longest.
		// If `gemma` → `local` were ordered first, every id this module claims needs
		// the local classify tier would actually reach resident Chat.
		const prefixes = routerBuiltinPrefixes().map(([prefix]) => prefix);
		const classifyAt = prefixes.indexOf(CLASSIFY_MODEL_PREFIX);
		const genericAt = prefixes.indexOf("gemma");
		expect(classifyAt).toBeGreaterThanOrEqual(0);
		expect(genericAt).toBeGreaterThanOrEqual(0);
		expect(classifyAt).toBeLessThan(genericAt);
		// And the prefix distinguishes the classifier from ordinary local gemmas.
		expect("gemma-3-12b-it".startsWith(CLASSIFY_MODEL_PREFIX)).toBe(false);
		expect("gemma2:9b".startsWith(CLASSIFY_MODEL_PREFIX)).toBe(false);
	});
});

describe("deriveClassifyTierState", () => {
	it("reports `absent` when Core does not register the sidecar", () => {
		// Only an older Core reaches this: current Core registers the manager
		// unconditionally and `statuses()` emits every non-startup_order sidecar.
		// A status map that answered WITHOUT our key is the only thing that means
		// "no such tier" — hence a map, not a pre-read boolean.
		for (const weightsPresent of [true, false, undefined]) {
			expect(
				deriveClassifyTierState({
					sidecarStatus: { llamacpp: true },
					weightsPresent,
				})
			).toBe("absent");
		}
	});

	it("stays `unknown` when the sidecar status itself has not answered", () => {
		// The distinction an earlier shape could not make: an unanswered status poll
		// is NOT evidence that the node lacks the tier, and claiming `absent` here
		// would put a confident "no local classifier" badge on a healthy node.
		for (const weightsPresent of [true, false, undefined]) {
			expect(
				deriveClassifyTierState({ sidecarStatus: undefined, weightsPresent })
			).toBe("unknown");
		}
	});

	it("reports `running` without waiting on the weights probe", () => {
		// A resident process proves the weights exist (the start path bails on a
		// missing GGUF), so a failed/pending weights probe must not downgrade a
		// demonstrably working tier.
		for (const weightsPresent of [true, false, undefined]) {
			expect(
				deriveClassifyTierState({
					sidecarStatus: { [CLASSIFY_SIDECAR_NAME]: true },
					weightsPresent,
				})
			).toBe("running");
		}
	});

	it("reports `idle` for the lazy resting state", () => {
		expect(
			deriveClassifyTierState({
				sidecarStatus: { [CLASSIFY_SIDECAR_NAME]: false },
				weightsPresent: true,
			})
		).toBe("idle");
	});

	it("reports `unweighted` when the sidecar is registered but has no weights", () => {
		// The reachable failure: onboarding's classifier download is non-fatal, so
		// the sidecar stays registered while every start attempt bails.
		expect(
			deriveClassifyTierState({
				sidecarStatus: { [CLASSIFY_SIDECAR_NAME]: false },
				weightsPresent: false,
			})
		).toBe("unweighted");
	});

	it("stays `unknown` while the weights probe has not answered", () => {
		expect(
			deriveClassifyTierState({
				sidecarStatus: { [CLASSIFY_SIDECAR_NAME]: false },
				weightsPresent: undefined,
			})
		).toBe("unknown");
	});

	it("gives every state resolvable copy, and a reason for the two failures", () => {
		const states = [
			"absent",
			"idle",
			"running",
			"unweighted",
		] as const satisfies readonly (keyof typeof CLASSIFY_TIER_COPY)[];
		for (const state of states) {
			expect(CLASSIFY_TIER_COPY[state].badge.length).toBeGreaterThan(0);
			expect(CLASSIFY_TIER_COPY[state].hint.length).toBeGreaterThan(0);
		}
		// The two cards compose their own consequence onto this clause, so a
		// missing one would render "…, but  — so the call will fail".
		expect(CLASSIFY_TIER_COPY.absent.reason).toBeTruthy();
		expect(CLASSIFY_TIER_COPY.unweighted.reason).toBeTruthy();
		expect(CLASSIFY_TIER_COPY.idle.reason).toBeUndefined();
		expect(CLASSIFY_TIER_COPY.running.reason).toBeUndefined();
	});
});

describe("classifyTierServable", () => {
	it("offers the tier's model id only when this node can serve it", () => {
		expect(classifyTierServable("idle")).toBe(true);
		expect(classifyTierServable("running")).toBe(true);
		for (const state of ["absent", "unweighted", "unknown"] as const) {
			expect(classifyTierServable(state)).toBe(false);
		}
	});
});

describe("withResolvedInspectorModels", () => {
	// The bug: a save shipped `inspector.model: ""`, Core read the proxied body
	// BEFORE the gateway resolved anything and took the blank as "no classify
	// selection", so `llamacpp-classify` never started — then the gateway resolved
	// the same blank to the classify id and called a dead port, and the inspector
	// fails open. The dialog's badge could not reveal it (it mirrored the
	// resolution for DISPLAY, so with weights on disk the tier read `idle`).
	//
	// Deliberately NOT a mirror test of Core's `patch_selects_classify_tier`: that
	// predicate is being changed in the same round to also treat blank+enabled as a
	// selection, and a test pinned to its current blank-rejection branch would go
	// red for the wrong reason. The dependency is documented in prose on the
	// function instead.
	const firewall = <T extends Partial<InspectorConfig> | undefined>(
		inspector: T
	) => {
		const patch = {
			firewall: {
				enabled: true,
				log_detections: true,
				policy: "block" as const,
				redact_pii: false,
				redact_secrets: false,
				scan_inbound: true,
				scan_outbound: false,
				inspector,
			},
		};
		return patch satisfies GatewayConfigPatchInput;
	};

	it("writes the classify id when the model is blank", () => {
		const patch = firewall({ ...DEFAULT_INSPECTOR, enabled: true, model: "" });
		expect(withResolvedInspectorModels(patch).firewall?.inspector?.model).toBe(
			CLASSIFY_MODEL_ID
		);
	});

	it("treats a whitespace-only model as blank", () => {
		// What a cleared-then-retyped picker leaves behind, and what Core's own
		// `selects()` trims away before its emptiness check.
		const patch = firewall({ ...DEFAULT_INSPECTOR, model: "   " });
		expect(withResolvedInspectorModels(patch).firewall?.inspector?.model).toBe(
			CLASSIFY_MODEL_ID
		);
	});

	it("normalizes regardless of `enabled`, so a later toggle-on carries an id", () => {
		// Only `enabled` inspectors can select the tier, but the toggle and the model
		// are saved independently: normalizing only when enabled would leave the
		// blank persisted, and the push that flips the switch would ship it.
		const patch = firewall({ ...DEFAULT_INSPECTOR, enabled: false, model: "" });
		expect(withResolvedInspectorModels(patch).firewall?.inspector?.model).toBe(
			CLASSIFY_MODEL_ID
		);
	});

	it("leaves a chosen model alone, hosted or local", () => {
		for (const model of ["gpt-4o-mini", "openrouter/foo", CLASSIFY_MODEL_ID]) {
			const patch = firewall({ ...DEFAULT_INSPECTOR, model });
			expect(
				withResolvedInspectorModels(patch).firewall?.inspector?.model
			).toBe(model);
		}
	});

	it("survives an inspector object with no model key at all", () => {
		// `model` is typed `string`, but this runs on a transport path fed by whatever
		// the gateway serialized — a throw here would break the save handler.
		const patch = firewall({ enabled: true });
		expect(
			z
				.object({ model: z.string() })
				.parse(withResolvedInspectorModels(patch).firewall?.inspector).model
		).toBe(CLASSIFY_MODEL_ID);
	});

	it("never mutates the input patch", () => {
		// These patches ARE React draft state (`draft.firewall` in GuardrailsSection),
		// so mutating one would be a worse bug than the blank it fixes.
		const inspector = { ...DEFAULT_INSPECTOR, model: "" };
		const patch = firewall(inspector);
		const before = JSON.stringify(patch);
		withResolvedInspectorModels(patch);
		expect(JSON.stringify(patch)).toBe(before);
		expect(inspector.model).toBe("");
	});

	it("returns the same object when there is nothing to resolve", () => {
		// Identity is the contract: every gateway save (routing, budgets, auth,
		// evaluators) flows through this, and none of them should be cloned.
		const patch: GatewayConfigPatch = { auth: { api_keys: [] } };
		expect(withResolvedInspectorModels(patch)).toBe(patch);
		const withModel = firewall({ ...DEFAULT_INSPECTOR });
		expect(withResolvedInspectorModels(withModel)).toBe(withModel);
	});

	it("leaves a firewall section that carries no inspector untouched", () => {
		const patch = firewall(undefined);
		const out = withResolvedInspectorModels(patch);
		expect(out).toBe(patch);
		expect(out.firewall?.inspector).toBeUndefined();
	});

	it("keeps an overlay's `inspector: null` as null", () => {
		// `null` is an overlay's "inherit the broader scope"; turning it into an
		// object would silently create an override the user never asked for.
		const patch: GatewayConfigPatch = {
			firewall_agent_overlays: { "agent-1": { inspector: null } },
		};
		const out = withResolvedInspectorModels(patch);
		expect(out.firewall_agent_overlays?.["agent-1"]?.inspector).toBeNull();
		expect(out).toBe(patch);
	});

	it("resolves overlay inspectors in both stores", () => {
		// Consistency only: Core's predicate reads `/firewall/inspector/model` at the
		// TOP level, so an overlay-only inspector does not start the sidecar either
		// way — this keeps what is persisted equal to what the card renders.
		const patch: GatewayConfigPatch = {
			firewall_org_overlays: {
				"org-1": { inspector: { ...DEFAULT_INSPECTOR, model: "" } },
				"org-2": { inspector: null },
				"org-3": { enabled: true },
			},
			firewall_agent_overlays: {
				"agent-1": { inspector: { ...DEFAULT_INSPECTOR, model: " " } },
			},
		};
		const out = withResolvedInspectorModels(patch);
		expect(out.firewall_org_overlays?.["org-1"]?.inspector?.model).toBe(
			CLASSIFY_MODEL_ID
		);
		expect(out.firewall_org_overlays?.["org-2"]?.inspector).toBeNull();
		expect(out.firewall_org_overlays?.["org-3"]?.inspector).toBeUndefined();
		expect(out.firewall_agent_overlays?.["agent-1"]?.inspector?.model).toBe(
			CLASSIFY_MODEL_ID
		);
		// Untouched siblings keep their identity even inside a changed store.
		expect(out.firewall_org_overlays?.["org-3"]).toBe(
			patch.firewall_org_overlays?.["org-3"]
		);
	});

	it("is wired into the save transport, not merely exported", async () => {
		// The failure family this round exists to close: a correct helper nothing
		// calls. Asserted against the actual PUT body, because that body IS what Core
		// reads to decide whether to start the sidecar — a passing pure-function test
		// would say nothing about it.
		const originalFetch = globalThis.fetch;
		// Recorded EAGERLY, not inside `text()`: `request` only reads the body on its
		// success path, so a lazy recorder could leave `sentBody` as "" and let the
		// assertion below pass green for the wrong reason.
		let sentBody: string | null = null;
		globalThis.fetch = Object.assign(
			async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
				sentBody = String(init?.body ?? "");
				return Response.json({ ok: true });
			},
			{ preconnect: originalFetch.preconnect }
		);
		try {
			await updateGatewayConfig(
				{ url: "http://127.0.0.1:7980", token: null, userJwt: null },
				firewall({ ...DEFAULT_INSPECTOR, enabled: true, model: "" })
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(sentBody).not.toBeNull();
		expect(JSON.parse(sentBody ?? "{}").firewall.inspector.model).toBe(
			CLASSIFY_MODEL_ID
		);
	});

	it("writes the same id the UI already offers, so the wire matches the badge", () => {
		// The one-click "Use it" button and `DEFAULT_INSPECTOR` both write
		// CLASSIFY_MODEL_ID, so normalizing introduces no new value class — and the id
		// carries the router prefix that reaches the `classify` provider (asserted
		// above), which is what makes the write routable.
		expect(DEFAULT_INSPECTOR.model).toBe(CLASSIFY_MODEL_ID);
		expect(CLASSIFY_MODEL_ID.startsWith(CLASSIFY_MODEL_PREFIX)).toBe(true);
	});
});

describe("CLASSIFY_TIER_COPY does not overstate a recoverable state", () => {
	it("drops the dead-end claim about the unweighted tier", () => {
		// Core's boot spawns `install_local_stack` unconditionally
		// (apps/core/src/main.rs) and that routine re-attempts the classifier GGUF
		// (apps/core/src/sidecar/onboarding.rs), so the download is retried on every
		// start. Pinned to the exact phrase that was wrong rather than banning the
		// word "never" outright: a blanket substring ban would outlaw phrasings that
		// are perfectly true (e.g. "these weights never expire") and would assert
		// something broader than what was actually verified.
		const { hint, reason } = CLASSIFY_TIER_COPY.unweighted;
		expect(hint).not.toContain("can never start");
		expect(reason).not.toContain("never finished");
	});

	it("states the remedy in `hint`, which both cards render", () => {
		// `ClassifyTierNote` renders `hint` beside the badge on the inspector card and
		// the smart-routing card alike, so `hint` is the one string that reaches both.
		expect(CLASSIFY_TIER_COPY.unweighted.hint).toContain("restarting Core");
	});

	it("keeps `reason` a single mid-sentence clause", () => {
		// Both cards splice it mid-sentence — GatewayDialog.tsx:1946 ("…, but {reason}
		// — so the classification call will fail…") and :3948 ("…, but {reason}. The
		// inspection call will fail…") — so sentence-terminating punctuation, or a
		// leading capital, renders as broken prose. That is what these two assertions
		// forbid; nothing about the wording beyond it.
		for (const state of ["absent", "unweighted"] as const) {
			const reason = CLASSIFY_TIER_COPY[state].reason ?? "";
			expect(reason).not.toContain(".");
			expect(reason[0]).toBe(reason[0]?.toLowerCase());
		}
	});
});

describe("classifyTierCannotServeModel", () => {
	it("warns for both unservable states, not just a missing sidecar", () => {
		// The pre-existing gate only fired on `absent`, which no current Core
		// reports — so the warning it guarded could never render.
		expect(classifyTierCannotServeModel("absent", CLASSIFY_MODEL_ID)).toBe(
			true
		);
		expect(classifyTierCannotServeModel("unweighted", CLASSIFY_MODEL_ID)).toBe(
			true
		);
	});

	it("stays quiet when the tier can serve, or has not answered", () => {
		for (const state of ["idle", "running", "unknown"] as const) {
			expect(classifyTierCannotServeModel(state, CLASSIFY_MODEL_ID)).toBe(
				false
			);
		}
	});

	it("only judges models the local tier would serve", () => {
		expect(classifyTierCannotServeModel("unweighted", "gpt-4o-mini")).toBe(
			false
		);
		expect(classifyTierCannotServeModel("unweighted", "gemma-3-12b-it")).toBe(
			false
		);
		// Another quant of the classify-tier model still needs the local sidecar.
		expect(
			classifyTierCannotServeModel(
				"unweighted",
				`${CLASSIFY_MODEL_PREFIX}-Q8_0`
			)
		).toBe(true);
		// Whitespace is what a cleared-then-typed box leaves behind.
		expect(
			classifyTierCannotServeModel("unweighted", `  ${CLASSIFY_MODEL_ID}  `)
		).toBe(true);
	});
});

describe("ALERT_TIERS mirrors the Rust AlertTier", () => {
	it("matches the enum's wire values in declaration order", () => {
		// Parsed out of crates/gateway/contracts at test time. A renamed or reordered
		// variant lands here rather than in a shipped build, because the failure mode
		// on the wire is invisible: serde rejects nothing it was not asked to reject,
		// and a tier value the gateway does not recognise is a setting that silently
		// never fires. Order is asserted, not just membership — the Rust `Ord` derive
		// is what `pipeline::max_tier` uses to pick the winning tier across rules.
		// Widened to `string[]` deliberately: the parser returns whatever Rust says, so
		// comparing it against the literal-union array would be a type error rather
		// than the value comparison this test is for.
		const tiers: string[] = [...ALERT_TIERS];
		expect(tiers).toEqual(
			rustEnumWireVariants(contractsRs, CONTRACTS_RS, "AlertTier", "lowercase")
		);
	});

	it("starts at the Rust `#[default]`, so an unset tier reads as the UI's first option", () => {
		// Every pre-existing config has no `alert` key at all (`#[serde(default)]`), so
		// the desktop coalesces a missing tier to ALERT_TIERS[0] — on fetch, in the
		// guardrails row, in the budget edit dialog's seed, and in the session editor's
		// initial state. If Rust's default stopped being the quietest variant, every one
		// of those would be inventing a tier the operator never chose.
		const block = rustBlock(contractsRs, CONTRACTS_RS, "pub enum AlertTier");
		const defaultVariant = match(
			block,
			CONTRACTS_RS,
			/#\[default\]\s*(\w+)/,
			"#[default] variant of AlertTier"
		).toLowerCase();
		expect(defaultVariant).toBe(ALERT_TIERS[0]);
		expect(ALERT_TIERS[0]).toBe("silent");
	});

	it("agrees with Core's independent mirror of the enum, wire value for wire value", () => {
		// The tier crosses a PROCESS boundary, and the two sides do not share a type:
		// the gateway stamps `x-ryu-policy-alert` from `ryu_gw_contracts::AlertTier`,
		// Core decodes it into its own `policy_alerts::AlertTier`. Nothing makes them
		// agree at compile time, and the failure is silent in both directions —
		// `from_header` is deliberately lenient, so an unrecognised tier decodes to
		// `None` and the alert is dropped with no error logged anywhere.
		//
		// The rename rules are already different (`lowercase` vs `snake_case`), which
		// only happens to be harmless because all four variants are single words. Both
		// rules are asserted by `rustEnumWireVariants` itself, so this comparison
		// catches a divergence introduced either by a renamed variant or by a
		// multi-word one that the two rules spell differently.
		const gatewaySide = rustEnumWireVariants(
			contractsRs,
			CONTRACTS_RS,
			"AlertTier",
			"lowercase"
		);
		const coreSide = rustEnumWireVariants(
			corePolicyAlertsRs,
			CORE_POLICY_ALERTS_RS,
			"AlertTier",
			"snake_case"
		);
		// Not vacuous: a parse that silently matched the wrong block would hand back
		// two empty arrays and `toEqual` would pass. Pin the arity to the TS union.
		expect(coreSide.length).toBe(ALERT_TIERS.length);
		expect(coreSide).toEqual(gatewaySide);

		// And the rename rules really are the two different ones claimed above: the
		// helper rejects the attribute before it parses a single variant, so this
		// establishes only that Core's enum carries `snake_case` and NOT `lowercase`.
		// It says nothing about the variant lists — the arity pin above is what keeps
		// the equality assertion from passing on two empty arrays.
		expect(() =>
			rustEnumWireVariants(
				corePolicyAlertsRs,
				CORE_POLICY_ALERTS_RS,
				"AlertTier",
				"lowercase"
			)
		).toThrow();
	});
});

describe("the alert tier exists on every Rust struct the desktop writes it onto", () => {
	// Three separate save paths carry a tier, and each one is a different Rust
	// struct. A TS field with no Rust counterpart is dropped by serde on arrival —
	// the save succeeds, the setting evaporates.
	it("is a field on the firewall config (the guardrails card's node base)", () => {
		expect(
			rustStructFieldType(
				gatewayConfigRs,
				GATEWAY_CONFIG_RS,
				"FirewallConfig",
				"alert"
			)
		).toBe("AlertTier");
	});

	it("is a field on a budget rule (the per-user / per-agent dialogs)", () => {
		expect(
			rustStructFieldType(budgetRs, BUDGET_RS, "BudgetRule", "alert")
		).toBe("AlertTier");
	});

	it("is a field on the session budget (the global per-session cap)", () => {
		expect(
			rustStructFieldType(budgetRs, BUDGET_RS, "SessionBudgetConfig", "alert")
		).toBe("AlertTier");
	});
});

describe("buildBudgetRule", () => {
	it("carries the alert tier onto the rule", () => {
		// The bug this function exists to close: three hand-built literals in
		// GatewayDialog.tsx named limit/action/downgrade_to/restrict_max_tokens and
		// nothing else, and `PUT /v1/config` replaces the whole BudgetConfig — so every
		// save reset the tier to silent no matter what the operator picked.
		expect(
			buildBudgetRule({ limit: 100, action: "stop", alert: "email" }).alert
		).toBe("email");
	});

	it("keeps the tier for every action, not just the blocking ones", () => {
		// A low-enforcement rule with a high tier is a supported combination: the
		// gateway takes the MAX tier across matched decisions independently of which
		// enforcement won, so `notify` + `email` must survive the trip.
		for (const action of ["notify", "downgrade", "restrict", "stop"] as const) {
			expect(buildBudgetRule({ limit: 1, action, alert: "fanout" }).alert).toBe(
				"fanout"
			);
		}
	});

	it("defaults to silent, matching the Rust `#[serde(default)]`", () => {
		expect(buildBudgetRule({ limit: 0, action: "notify" }).alert).toBe(
			"silent"
		);
	});

	it("emits the tier even at silent, so the wire equals what the card shows", () => {
		// Omitting it would also deserialize to Silent, but then a rule read back has
		// no key while the dialog displays one — the ambiguity that made the original
		// wipe hard to see.
		expect(
			Object.hasOwn(buildBudgetRule({ limit: 0, action: "notify" }), "alert")
		).toBe(true);
	});

	it("still applies the action-conditional fields exactly as the dialogs did", () => {
		const downgrade = buildBudgetRule({
			limit: 5,
			action: "downgrade",
			downgradeTo: "  gpt-4o-mini  ",
			restrictMaxTokens: "512",
		});
		expect(downgrade.downgrade_to).toBe("gpt-4o-mini");
		// `restrict_max_tokens` belongs to `restrict`; carrying it on a downgrade rule
		// would persist a cap the gateway never reads.
		expect(downgrade.restrict_max_tokens).toBeUndefined();

		const restrict = buildBudgetRule({
			limit: 5,
			action: "restrict",
			downgradeTo: "gpt-4o-mini",
			restrictMaxTokens: "512",
		});
		expect(restrict.restrict_max_tokens).toBe(512);
		expect(restrict.downgrade_to).toBeUndefined();
	});

	it("drops a cap that is not a positive integer instead of shipping junk", () => {
		for (const raw of ["", "   ", "0", "-1", "12.5", "abc"]) {
			expect(
				buildBudgetRule({
					limit: 5,
					action: "restrict",
					restrictMaxTokens: raw,
				}).restrict_max_tokens
			).toBeUndefined();
		}
		// A number, not a string, is what SessionBudgetEditor could hand it.
		expect(
			buildBudgetRule({ limit: 5, action: "restrict", restrictMaxTokens: 128 })
				.restrict_max_tokens
		).toBe(128);
	});

	it("drops a blank downgrade model, leaving the gateway's restrict fallback", () => {
		expect(
			buildBudgetRule({
				limit: 5,
				action: "downgrade",
				downgradeTo: "   ",
			}).downgrade_to
		).toBeUndefined();
	});

	it("round-trips a rule through the shape an edit dialog seeds from", () => {
		// The edit path is where the wipe actually bit: open an existing rule, change
		// nothing, save. Re-building from the previous rule's own fields must be a
		// fixed point.
		const original = buildBudgetRule({
			limit: 900,
			action: "restrict",
			alert: "fanout",
			restrictMaxTokens: 64,
		});
		const reopened = buildBudgetRule({
			limit: original.limit,
			action: original.action,
			alert: original.alert,
			downgradeTo: original.downgrade_to,
			restrictMaxTokens: original.restrict_max_tokens,
		});
		expect(reopened).toEqual(original);
	});
});

describe("withAgentBudget", () => {
	it("changes one agent without dropping other budget scopes", () => {
		const budgets = {
			users: {
				user1: buildBudgetRule({ limit: 10, action: "notify" }),
			},
			agents: {
				other: buildBudgetRule({ limit: 20, action: "stop" }),
			},
			session: DEFAULT_SESSION_BUDGET,
		};
		const next = withAgentBudget(
			budgets,
			"agent-a",
			buildBudgetRule({ limit: 100, action: "restrict" })
		);

		expect(next.users).toEqual(budgets.users);
		expect(next.agents.other).toEqual(budgets.agents.other);
		expect(next.agents["agent-a"]?.limit).toBe(100);
		expect(next.session).toBe(budgets.session);
		expect(next).not.toBe(budgets);
	});

	it("removes only the selected agent rule", () => {
		const budgets = {
			users: {},
			agents: {
				"agent-a": buildBudgetRule({ limit: 100, action: "stop" }),
				"agent-b": buildBudgetRule({ limit: 200, action: "notify" }),
			},
			session: DEFAULT_SESSION_BUDGET,
		};

		const next = withAgentBudget(budgets, "agent-a", null);

		expect(next.agents).toEqual({ "agent-b": budgets.agents["agent-b"] });
		expect(next.session).toBe(budgets.session);
	});
});

describe("DEFAULT_SESSION_BUDGET", () => {
	it("claims the tier Rust's own default would produce", () => {
		// This literal stands in for a session rule the gateway omitted, so a tier
		// stronger than `AlertTier::default()` here would make the card promise
		// delivery on a node that has none configured.
		expect(DEFAULT_SESSION_BUDGET.alert).toBe(ALERT_TIERS[0]);
		expect(
			rustBlock(budgetRs, BUDGET_RS, "impl Default for SessionBudgetConfig")
		).toContain("alert: AlertTier::default()");
	});
});

describe("the save transport leaves the firewall alert tier alone", () => {
	it("carries `firewall.alert` through the inspector normalization", () => {
		// `withResolvedInspectorModels` rebuilds the firewall section when it resolves a
		// blank inspector model. It spreads, so the tier rides along — asserted because
		// a future rewrite into an explicit field list is exactly how a new field gets
		// dropped on the way to the wire.
		const patch: GatewayConfigPatch = {
			firewall: {
				alert: "email",
				enabled: true,
				log_detections: true,
				policy: "block",
				redact_pii: true,
				redact_secrets: true,
				scan_inbound: true,
				scan_outbound: true,
				inspector: { ...DEFAULT_INSPECTOR, model: "" },
			},
		};
		const out = withResolvedInspectorModels(patch);
		expect(out.firewall?.inspector?.model).toBe(CLASSIFY_MODEL_ID);
		expect(out.firewall?.alert).toBe("email");
	});

	it("keeps an overlay's `alert: null` as null (inherit, not override)", () => {
		const patch: GatewayConfigPatch = {
			firewall_agent_overlays: { "agent-1": { alert: null } },
		};
		expect(
			withResolvedInspectorModels(patch).firewall_agent_overlays?.["agent-1"]
				?.alert
		).toBeNull();
	});
});

describe("the firewall alert tier is lockable on both sides", () => {
	// A lock toggle is a promise about ANOTHER PROCESS: the dialog only writes the
	// string `"alert"` into `firewall.locked_fields`, and whether that does anything
	// is decided by the gateway's resolver. The pair below is the drift guard —
	// either half alone can regress silently. (This row shipped WITHOUT a toggle,
	// justified by the resolver having no `alert` arm; the arm landed in the same
	// batch, which is exactly the cross-file assumption this test pins down.)
	const resolveRs = rustSource("apps/gateway/src/firewall/resolve.rs");
	// The editor rows moved out of GatewayDialog.tsx into the shared guardrails
	// block, which the dialog renders; the toggle now lives with the alert row.
	const dialog = rustSource(
		"packages/blocks/src/desktop/guardrails/firewall-rows.tsx"
	);

	it("offers the node-scope toggle in the dialog", () => {
		expect(dialog).toContain('ctx.toggleLock("alert")');
		expect(dialog).toContain('ctx.lockedHere.has("alert")');
	});

	it("has a resolver arm that honours the lock by RAISING, never lowering", () => {
		// `apply_overlay`'s `alert` arm must consult the lock set and, when locked,
		// go through `louder_alert`. A plain `cfg.alert = tier` would let a narrower
		// scope silence a locked tier — the no-loosen invariant, in tier form.
		const applyOverlay = rustBlock(
			resolveRs,
			"apps/gateway/src/firewall/resolve.rs",
			"fn apply_overlay("
		);
		expect(applyOverlay).toContain('locked.contains("alert")');
		expect(applyOverlay).toContain("louder_alert(");
		// `max` over AlertTier's ascending-severity Ord is what makes "louder" mean
		// "stricter"; ALERT_TIERS mirrors that same order (asserted above).
		expect(
			rustBlock(
				resolveRs,
				"apps/gateway/src/firewall/resolve.rs",
				"fn louder_alert("
			)
		).toContain("current.max(incoming)");
	});

	it("names `alert` as a canonical lockable field", () => {
		// The doc on `FirewallConfig::locked_fields` is the canonical-names list; a
		// name missing from it reads to the next author as not-lockable, which is how
		// the toggle came to be omitted the first time.
		const lockedFieldsDoc = gatewayConfigRs.slice(
			gatewayConfigRs.indexOf("Canonical names are the serde"),
			gatewayConfigRs.indexOf("pub locked_fields: Vec<String>")
		);
		expect(lockedFieldsDoc).toContain("`alert`");
	});

	it("leaves `alert` UNLOCKED by default", () => {
		// A notification dial is not a protection dial. Locking it out of the box
		// would freeze every org/agent at the node's tier, and both the dialog's and
		// the resolver's comments claim it does not — so assert the claim.
		expect(
			rustBlock(
				gatewayConfigRs,
				GATEWAY_CONFIG_RS,
				"fn default_firewall_locked_fields("
			)
		).not.toContain('"alert"');
	});
});

describe("the budget dialogs go through buildBudgetRule", () => {
	// The wipe was a copy-pasted object literal in three places, and the two that
	// remain live in a `.tsx` this test cannot import (React + `@ryu/*` do not
	// resolve under `bun test` here). So the guard is textual, in the same spirit as
	// the "wired into the save transport, not merely exported" test: a correct
	// helper nothing calls is the failure family this file was written for.
	//
	// `rustSource` is reused purely as "read a repo file, throw loudly if missing"
	// — the name is about its other callers, not a claim about this one.
	const dialog = rustSource(
		"apps/desktop/src/components/gateway/GatewayDialog.tsx"
	);

	it("calls the shared builder", () => {
		expect(dialog).toContain("buildBudgetRule(");
	});

	it("builds no BudgetRule literal of its own", () => {
		// `const rule: BudgetRule = {` / `const next: BudgetRule = {` were the exact
		// forms of the three wipes. Annotated literals only — a rule assembled with no
		// annotation at all would slip past this, which is why the builder's own unit
		// tests above carry the correctness weight and this only guards the shape that
		// actually regressed.
		expect(/:\s*BudgetRule\s*=\s*\{/.test(dialog)).toBe(false);
	});
});

// ─── Modality routing (routing.modality_map) ─────────────────────────────────
//
// Four kinds of guard, in dependency order:
//
//  1. That the gateway's `RoutingView` really serves `modality_map` /
//     `eval_routing`. The desktop editor is built ON TOP of that, and a field
//     the view stops returning turns the editor into a data-loss machine rather
//     than into a visible error — so the precondition is pinned, not assumed.
//  2. MIRROR tests for the wire vocabulary: the `Modality` variants that are the
//     map's KEYS, and the `ModalityMapping` fields that are its values. A key or
//     field name that Rust does not know is dropped by serde on arrival — the
//     save returns 200 and the setting evaporates.
//  3. Round-trip tests over `withModalityMapping`, the pure half of the save
//     path. `PUT /v1/config { routing }` replaces the section WHOLESALE
//     (`updated_config.routing = routing.clone()`) and every `RoutingConfig`
//     field is `#[serde(default)]`, so any sibling the desktop fails to carry
//     through is a sibling it erases. That is the A7 defect; these pin the fix.
//  4. Textual wiring guards on the dialog, in the same spirit as the
//     buildBudgetRule guards above — the `.tsx` cannot be imported here.

const GATEWAY_API_CONFIG_RS = "apps/gateway/src/api/config.rs";
const GATEWAY_PROVIDERS_RS = "apps/gateway/src/providers/mod.rs";
const gatewayApiConfigRs = rustSource(GATEWAY_API_CONFIG_RS);
const gatewayProvidersRs = rustSource(GATEWAY_PROVIDERS_RS);
const gatewayDialogTsx = rustSource(
	"apps/desktop/src/components/gateway/GatewayDialog.tsx"
);
const providerPoolsEditorTsx = rustSource(
	"apps/desktop/src/components/gateway/ProviderPoolsEditor.tsx"
);

describe("the gateway serves the routing fields this editor round-trips", () => {
	it("declares modality_map and eval_routing on RoutingView", () => {
		// Without these two lines the desktop cannot SEE either field, and because
		// the PUT replaces routing wholesale it then erases both on the next save of
		// anything else in the card. The editor is only safe because the view exists.
		const view = rustBlock(
			gatewayApiConfigRs,
			GATEWAY_API_CONFIG_RS,
			"struct RoutingView"
		);
		expect(view).toContain("modality_map:");
		expect(view).toContain("eval_routing:");
	});

	it("populates them from the persisted routing, not from an empty default", () => {
		// A Rust struct literal must be exhaustive, so the fields above are always
		// SET — but they could be set to `HashMap::new()`. Pin the source.
		expect(
			/modality_map: routing\.modality_map\.clone\(\)/.test(gatewayApiConfigRs)
		).toBe(true);
		expect(
			/eval_routing: routing\.eval_routing\.clone\(\)/.test(gatewayApiConfigRs)
		).toBe(true);
	});

	it("sends the edited routing section with unrelated routes and policy intact", async () => {
		const routing: GatewayRoutingConfig = {
			...SERVED_ROUTING_BASE,
			model_map: {
				"saved-model": { provider: "anthropic", provider_model: "claude" },
			},
			fallback_chain: ["anthropic"],
			smart_routing: { ...DEFAULT_SMART_ROUTING, enabled: true },
			modality_map: { image: { provider: "fal", model: "saved-image-model" } },
		};
		const edited = withModalityMapping(routing, "tts", {
			provider: "elevenlabs",
			model: "voice-model",
		});
		const originalFetch = globalThis.fetch;
		let sentBody = "";
		// SAFETY: the stub returns the same Response contract as fetch; only network I/O is replaced.
		globalThis.fetch = (async (_input, init) => {
			sentBody = String(init?.body);
			return Response.json({ ok: true });
		}) as typeof fetch;
		try {
			expect(
				await updateGatewayConfig(
					{ url: "http://127.0.0.1:7980", token: null, userJwt: null },
					{ routing: edited }
				)
			).toEqual({ ok: true });
			expect(JSON.parse(sentBody)).toEqual({
				routing: {
					...routing,
					model_map: {
						"saved-model": { provider: "anthropic", provider_model: "claude" },
					},
					fallback_chain: ["anthropic"],
					smart_routing: { ...DEFAULT_SMART_ROUTING, enabled: true },
					modality_map: {
						image: { provider: "fal", model: "saved-image-model" },
						tts: { provider: "elevenlabs", model: "voice-model" },
					},
				},
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("still assigns the routing section wholesale, which is why omission erases", () => {
		// This is the premise behind `routingViewIncludesModalityMap` and behind the
		// spread in `withModalityMapping`. If a clobber guard is ever added to
		// `routing` (one exists for `custom_evaluators`), this assertion is where the
		// change surfaces, and the desktop's "omission == erasure" reasoning — plus
		// the warning the dialog shows an older gateway — would need revisiting.
		expect(
			/section!\("routing", &patch\.routing\);/.test(gatewayApiConfigRs) &&
				/\.insert\(name\.to_owned\(\), value\)/.test(
					rustBlock(
						gatewayApiConfigRs,
						GATEWAY_API_CONFIG_RS,
						"fn commit_authored_config("
					)
				)
		).toBe(true);
		const routingConfig = rustBlock(
			gatewayConfigRs,
			GATEWAY_CONFIG_RS,
			"pub struct RoutingConfig"
		);
		// `#[serde(default)]` immediately above the field is what turns an omitted
		// key into an empty map rather than a deserialize error.
		expect(
			/#\[serde\(default\)\]\s*pub modality_map:/.test(routingConfig)
		).toBe(true);
	});
});

describe("MODALITIES mirrors the Rust Modality enum", () => {
	it("matches the enum's wire values in declaration order", () => {
		// These strings are the KEYS of `routing.modality_map`. A key Rust does not
		// know deserializes to nothing: the PUT succeeds and the mapping is ignored,
		// which is indistinguishable from "the provider is broken". Order is pinned
		// too because it is the order the six rows render in.
		const modalities: string[] = [...MODALITIES];
		expect(modalities).toEqual(
			rustEnumWireVariants(
				gatewayConfigRs,
				GATEWAY_CONFIG_RS,
				"Modality",
				"lowercase"
			)
		);
	});

	it("is the key type of routing.modality_map", () => {
		// Proves the enum parsed above is the one that actually keys the map, rather
		// than a same-named enum used somewhere else in the file. Matched with a
		// regex rather than `rustStructFieldType`, whose `[^,\n]+` capture stops at
		// the comma inside the generic and would compare a truncated type.
		const routingConfig = rustBlock(
			gatewayConfigRs,
			GATEWAY_CONFIG_RS,
			"pub struct RoutingConfig"
		);
		expect(
			/pub modality_map: HashMap<Modality, ModalityMapping>,/.test(
				routingConfig
			)
		).toBe(true);
	});
});

describe("ModalityMapping mirrors the Rust struct", () => {
	it("carries exactly provider and model", () => {
		const block = rustBlock(
			gatewayConfigRs,
			GATEWAY_CONFIG_RS,
			"pub struct ModalityMapping"
		);
		const fields = block.match(/^\s*pub \w+:/gm) ?? [];
		expect(fields.length).toBe(2);
		expect(
			rustStructFieldType(
				gatewayConfigRs,
				GATEWAY_CONFIG_RS,
				"ModalityMapping",
				"model"
			)
		).toBe("Option<String>");
	});

	it("types provider as the OPEN ProviderId, not the closed ProviderKind", () => {
		// This is why the TS field is `string` and why the editor offers the node's
		// whole `available_providers()` list instead of the `ProviderKind`-filtered
		// one the model-map editor uses. Narrowing it would make the map unable to
		// name fal / replicate / modal — the providers it exists for.
		expect(
			rustStructFieldType(
				gatewayConfigRs,
				GATEWAY_CONFIG_RS,
				"ModalityMapping",
				"provider"
			)
		).toBe("ProviderId");
		expect(gatewayConfigRs).toContain("pub struct ProviderId(pub String);");
	});

	it("substitutes the caller's model only for an ABSENT model, never a blank one", () => {
		// The reason `withModalityMapping` omits a blank model instead of sending
		// `""`. The router unwraps `Option`, so `Some("")` is forwarded to the
		// provider as a literal empty model name.
		expect(
			/mapping_model\s*\n?\s*\.clone\(\)\s*\n?\s*\.unwrap_or_else\(\|\| requested_model\.to_string\(\)\)/.test(
				routerRs
			)
		).toBe(true);
	});
});

describe("EvalRoutingConfig mirrors the Rust struct", () => {
	// No editor — the desktop's only job is to carry it through a routing save.
	// It is declared in TS solely so the field is visible to a reader auditing
	// what the round trip covers; the preservation itself comes from the spread.
	it("has the three fields the TS interface claims", () => {
		for (const field of ["enabled", "candidates", "explore_ratio"]) {
			expect(
				rustStructFieldType(
					gatewayConfigRs,
					GATEWAY_CONFIG_RS,
					"EvalRoutingConfig",
					field
				).length
			).toBeGreaterThan(0);
		}
	});

	it("is reachable on RoutingConfig under the key the desktop spreads", () => {
		expect(
			rustStructFieldType(
				gatewayConfigRs,
				GATEWAY_CONFIG_RS,
				"RoutingConfig",
				"eval_routing"
			)
		).toBe("EvalRoutingConfig");
	});
});

describe("routingViewIncludesModalityMap", () => {
	const base: GatewayRoutingConfig = {
		default_provider: "openai",
		model_map: {},
		fallback_chain: [],
	};

	it("is false when the gateway never sent the field", () => {
		expect(routingViewIncludesModalityMap(base)).toBe(false);
	});

	it("is true when the gateway sent an EMPTY map", () => {
		// The distinction the whole gate rests on: a gateway that serves the field
		// always emits the key (an empty `HashMap` serializes as `{}`), so "served,
		// nothing configured" must not read as "not served". Coalescing with `?? {}`
		// anywhere upstream would collapse these two into one.
		expect(routingViewIncludesModalityMap({ ...base, modality_map: {} })).toBe(
			true
		);
	});
});

describe("withModalityMapping", () => {
	/**
	 * A routing object shaped like a real `GET` response: every field the current
	 * `RoutingView` serves, plus one the TS interface has never heard of. The
	 * unknown key stands in for the next field someone adds to the view — the
	 * failure this whole family of tests is about is a save that drops what the
	 * client could not name.
	 */
	function fullRouting() {
		return {
			default_provider: "openai",
			model_map: { "gpt-4o": { provider: "openai", provider_model: "gpt-4o" } },
			fallback_chain: ["anthropic"],
			provider_tiers: { openai: 0, anthropic: 1 },
			eval_routing: {
				enabled: true,
				candidates: ["openai", "anthropic"],
				explore_ratio: 0.35,
			},
			smart_routing: { ...DEFAULT_SMART_ROUTING, enabled: true },
			modality_map: { image: { provider: "fal", model: "flux/dev" } },
			// Not in `GatewayRoutingConfig` on purpose.
			some_future_field: { kept: true },
		} satisfies GatewayRoutingConfig & { some_future_field: { kept: boolean } };
	}

	/**
	 * Read a key off a routing object without claiming the interface knows it.
	 * `GatewayRoutingConfig` has no index signature, so a direct
	 * `as Record<string, unknown>` is rejected as a non-overlapping conversion —
	 * the double step is the only honest spelling.
	 */
	const field = (routing: GatewayRoutingConfig, key: string) =>
		z.record(z.string(), rpcJsonResponseSchema).parse(routing)[key];

	it("preserves every other routing field, including one TS cannot name", () => {
		const before = fullRouting();
		const after = withModalityMapping(before, "tts", {
			provider: "replicate",
			model: "kokoro",
		});
		// Field-by-field rather than a whole-object compare, so a failure names the
		// field that was dropped.
		expect(after.default_provider).toBe(before.default_provider);
		expect(after.model_map).toEqual(before.model_map);
		expect(after.fallback_chain).toEqual(before.fallback_chain);
		expect(after.provider_tiers).toEqual(before.provider_tiers);
		expect(after.eval_routing).toEqual(before.eval_routing);
		expect(after.smart_routing).toEqual(before.smart_routing);
		// Read through `field`: `withModalityMapping` returns the narrow
		// `GatewayRoutingConfig` (correctly — widening it would let callers invent
		// fields), so a bare `after.some_future_field` does not typecheck under
		// `tsc --noEmit`, which neither `bun test` nor the esbuild-backed vite build
		// would ever have told us.
		expect(field(after, "some_future_field")).toEqual({ kept: true });
		// And the whole object differs from the input in exactly one key.
		const changed = Object.keys(after).filter(
			(k) =>
				JSON.stringify(field(after, k)) !== JSON.stringify(field(before, k))
		);
		expect(changed).toEqual(["modality_map"]);
	});

	it("leaves the other modality rows alone", () => {
		const after = withModalityMapping(fullRouting(), "tts", {
			provider: "replicate",
		});
		expect(after.modality_map?.image).toEqual({
			provider: "fal",
			model: "flux/dev",
		});
		expect(after.modality_map?.tts).toEqual({ provider: "replicate" });
	});

	it("omits a blank model instead of sending an empty string", () => {
		// `Some("")` would be forwarded to the provider as a literal empty model
		// name (see the router mirror above); absent means "forward the caller's".
		for (const model of ["", "   ", undefined]) {
			const after = withModalityMapping(fullRouting(), "video", {
				provider: "modal",
				model,
			});
			expect(after.modality_map?.video).toEqual({ provider: "modal" });
			expect("model" in (after.modality_map?.video ?? {})).toBe(false);
			// And it survives JSON encoding as an absent key, which is what the wire
			// actually carries — `{ model: undefined }` would also pass the check
			// above but is a different object before serialization.
			expect(JSON.stringify(after.modality_map?.video)).toBe(
				'{"provider":"modal"}'
			);
		}
	});

	it("trims the model and the provider", () => {
		const after = withModalityMapping(fullRouting(), "stt", {
			provider: " local ",
			model: " whisper-1 ",
		});
		expect(after.modality_map?.stt).toEqual({
			provider: "local",
			model: "whisper-1",
		});
	});

	it("clears a row, without disturbing its siblings or the rest of routing", () => {
		const before = fullRouting();
		const after = withModalityMapping(before, "image", null);
		expect(after.modality_map).toEqual({});
		expect("image" in (after.modality_map ?? {})).toBe(false);
		expect(after.eval_routing).toEqual(before.eval_routing);
	});

	it("seeds the map when the gateway sent an empty one", () => {
		const after = withModalityMapping(
			{
				default_provider: "openai",
				model_map: {},
				fallback_chain: [],
				modality_map: {},
			},
			"image",
			{ provider: "fal" }
		);
		expect(after.modality_map).toEqual({ image: { provider: "fal" } });
	});

	it("does not mutate its input", () => {
		// The caller keeps the fetched config in React state; an in-place edit would
		// make the "did anything change?" comparisons in the card lie.
		const before = fullRouting();
		const snapshot = JSON.stringify(before);
		withModalityMapping(before, "image", null);
		withModalityMapping(before, "tts", { provider: "fal", model: "x" });
		expect(JSON.stringify(before)).toBe(snapshot);
	});
});

describe("withRoutingDraftEdits", () => {
	/** A fresh `GET` after another card saved Smart Routing, eval routing and tiers. */
	function freshRouting() {
		return {
			default_provider: "openai",
			model_map: { "gpt-4o": { provider: "openai", provider_model: "gpt-4o" } },
			fallback_chain: ["anthropic", "mistral"],
			provider_tiers: { anthropic: 2, mistral: 1 },
			eval_routing: {
				enabled: true,
				candidates: ["openai"],
				explore_ratio: 0.2,
			},
			smart_routing: {
				...DEFAULT_SMART_ROUTING,
				enabled: true,
				rules: [{ description: "code questions", model: "claude-code" }],
			},
			modality_map: { image: { provider: "fal", model: "flux/dev" } },
			provider_pools: {},
			// Not in `GatewayRoutingConfig` on purpose.
			some_future_field: { kept: true },
		} satisfies GatewayRoutingConfig & { some_future_field: { kept: boolean } };
	}

	/** The copy the routing card loaded before any of those saves. */
	function staleBase(): GatewayRoutingConfig {
		return {
			default_provider: "openai",
			model_map: {},
			fallback_chain: ["anthropic", "mistral"],
			provider_tiers: { anthropic: 0, mistral: 1 },
			smart_routing: { ...DEFAULT_SMART_ROUTING, enabled: false },
		};
	}

	const field = (routing: GatewayRoutingConfig, key: string) =>
		z.record(z.string(), rpcJsonResponseSchema).parse(routing)[key];

	it("applies only the draft's own edits over a fresh read", () => {
		const fresh = freshRouting();
		const base = staleBase();
		const draft: GatewayRoutingConfig = {
			...base,
			default_provider: "anthropic",
			fallback_chain: ["mistral", "anthropic"],
			provider_tiers: { ...base.provider_tiers, mistral: 2 },
		};
		const freshBefore = structuredClone(fresh);
		const draftBefore = structuredClone(draft);

		const next = withRoutingDraftEdits(fresh, base, draft);

		expect(next.default_provider).toBe("anthropic");
		expect(next.fallback_chain).toEqual(["mistral", "anthropic"]);
		expect(next.fallback_chain).not.toBe(draft.fallback_chain);
		// The draft's mistral edit lands; anthropic keeps the tier saved elsewhere.
		expect(next.provider_tiers).toEqual({ anthropic: 2, mistral: 2 });
		expect(next.smart_routing).toEqual(fresh.smart_routing);
		expect(next.eval_routing).toEqual(fresh.eval_routing);
		expect(next.modality_map).toEqual(fresh.modality_map);
		expect(next.model_map).toEqual(fresh.model_map);
		expect(next.provider_pools).toEqual(fresh.provider_pools);
		expect(field(next, "some_future_field")).toEqual({ kept: true });
		expect(fresh).toEqual(freshBefore);
		expect(draft).toEqual(draftBefore);
	});

	it("keeps fields the draft never touched as the fresh read has them", () => {
		const fresh: GatewayRoutingConfig = {
			...freshRouting(),
			default_provider: "mistral",
			fallback_chain: ["openai"],
		};
		const base = staleBase();
		const next = withRoutingDraftEdits(fresh, base, { ...base });
		expect(next).toEqual(fresh);
	});
});

/**
 * The dialog's provider label tables, each sliced to its own declaration:
 * `PROVIDER_LABELS` ends at `} satisfies …` and `MODALITY_PROVIDER_LABELS` (a
 * `new Map(Object.entries({…}))`) at `);`, the first column-0 `}` or `)` after
 * the name.
 */
function dialogProviderLabelTables(): string {
	const labelled = (name: string): string => {
		const start = gatewayDialogTsx.indexOf(`const ${name} `);
		if (start < 0) {
			throw new Error(`wiring test could not find \`${name}\` in the dialog`);
		}
		const end = gatewayDialogTsx.slice(start).search(/\n[})]/);
		if (end < 0) {
			throw new Error(`wiring test found \`${name}\` but not its end`);
		}
		return gatewayDialogTsx.slice(start, start + end);
	};
	return labelled("MODALITY_PROVIDER_LABELS") + labelled("PROVIDER_LABELS");
}

/** The Provider pools editor's own `[id, label]` table, as written. */
function poolsEditorLabelEntries(): [string, string][] {
	const start = providerPoolsEditorTsx.indexOf("const PROVIDER_LABELS ");
	if (start < 0) {
		throw new Error("wiring test could not find PROVIDER_LABELS in the editor");
	}
	const end = providerPoolsEditorTsx.slice(start).search(/\n\]\);/);
	if (end < 0) {
		throw new Error("wiring test found PROVIDER_LABELS but not its end");
	}
	return [
		...providerPoolsEditorTsx
			.slice(start, start + end)
			.matchAll(/^\t\["([\w-]+)", "([^"]+)"\],$/gm),
	].map((m) => [m[1] ?? "", m[2] ?? ""]);
}

describe("the modality editor is wired into the routing card", () => {
	it("saves through withModalityMapping rather than its own literal", () => {
		expect(gatewayDialogTsx).toContain("withModalityMapping(cfg.routing,");
	});

	it("reads the map presence off the served config", () => {
		expect(gatewayDialogTsx).toContain(
			"routingViewIncludesModalityMap(config)"
		);
	});

	it("treats not-yet-loaded as a third state, not as not-served", () => {
		// `config` is null while the fetch is in flight AND whenever the gateway is
		// unreachable (the fetch effect returns early on `!reachable`). Folding
		// either into `served === false` would render the "this gateway does not
		// report its modality map" warning — an accusation that a healthy, current
		// node is about to drop a hand-written `[routing.modality_map]` — on every
		// dialog open. The ternary keeps the three states apart and the render site
		// drops the whole block for the null one.
		expect(gatewayDialogTsx).toContain(
			"config === null ? null : routingViewIncludesModalityMap(config)"
		);
		expect(gatewayDialogTsx).toContain(
			"{modalityMapServed === null ? null : ("
		);
	});

	it("offers the node's UNFILTERED provider list, not the ProviderKind subset", () => {
		// The crossed-unit defect this row set had to avoid. `RoutingCard` derives
		// `providers` as `configuredProviders.filter((p) => p in PROVIDER_LABELS)`,
		// and `PROVIDER_LABELS` is `Record<ProviderKind, string>` — a union that has
		// no `modal` / `replicate` / `fal`. Passing that filtered list here would
		// have shipped an editor that cannot select the providers it exists to
		// select. It must receive `configuredProviders` itself.
		const rows = gatewayDialogTsx.slice(
			gatewayDialogTsx.indexOf("<ModalityRoutingRows")
		);
		const usage = rows.slice(0, rows.indexOf("/>"));
		expect(usage).toContain("configuredProviders={configuredProviders}");
		expect(usage).not.toContain("configuredProviders={providers}");
	});

	it("labels every provider id the gateway registry can report", () => {
		// The ids come from the gateway's own registration-order test, so this fails
		// when a provider is added there and the desktop would render its raw id.
		const registryOrder = rustBlock(
			gatewayProvidersRs,
			GATEWAY_PROVIDERS_RS,
			"    fn every_configured_builtin_registers_in_deterministic_order"
		);
		// Ids may carry a hyphen (`openai-credits`), so the pattern must not stop
		// at `\w`: a hyphenated id the registry reports still needs a label.
		const ids = [...registryOrder.matchAll(/^\s{16}"([\w-]+)",$/gm)].map(
			(m) => m[1]
		);
		expect(ids).toContain("fal");
		expect(ids).toContain("replicate");
		expect(ids).toContain("modal");
		expect(ids).toContain("kiro");
		expect(ids).toContain("openai-credits");
		// `MODALITY_PROVIDER_LABELS` spreads `PROVIDER_LABELS` in, so the six
		// `ProviderKind` ids are covered by that spread and the literal only has to
		// name the rest: search the union of both literals.
		const labels = dialogProviderLabelTables();
		for (const id of ids) {
			expect({
				id,
				labelled: new RegExp(`^\\t+(?:${id}|"${id}"): "[^"]+",$`, "m").test(
					labels
				),
			}).toEqual({ id, labelled: true });
		}
		// Scope: this reads the builtin ids of the registration-order test only.
		// SDK-route ids (`genai-openai`, `genai-groq`, ...) are registered at
		// runtime from the `genai.accounts` map, so there is no closed list here to
		// check; the editors show them under their raw id (recorded as an open item
		// in docs/test-coverage-cloud-results/ultracode/gateway-donated-credits.md).
	});

	it("names the donated OpenAI credits provider apart from OpenAI, in the same words in both editors", () => {
		// `openai-credits` is a second OpenAI id with its own spend. A label that is
		// merely present would still pass if it were the raw id or a bare "OpenAI",
		// which erases the distinction the label exists to draw, so pin the text.
		const donated = "OpenAI (donated credits)";
		const modality = gatewayDialogTsx.match(
			/^\t+"openai-credits": "([^"]+)",$/m
		)?.[1];
		const pools = poolsEditorLabelEntries().find(
			([id]) => id === "openai-credits"
		)?.[1];
		expect({ modality, pools }).toEqual({ modality: donated, pools: donated });
	});

	it("keeps every provider label the Provider pools editor names identical to the dialog's", () => {
		// The pools editor keeps its own short table, so a label changed in the
		// dialog (or added to one table only) would drift apart silently.
		const dialogLabels = dialogProviderLabelTables();
		const entries = poolsEditorLabelEntries();
		expect(entries.length).toBeGreaterThan(0);
		for (const [id, label] of entries) {
			const dialog = new RegExp(
				`^\\t+(?:${id}|"${id}"): "([^"]+)",$`,
				"m"
			).exec(dialogLabels)?.[1];
			expect({ id, dialog }).toEqual({ id, dialog: label });
		}
	});
});

// ─── routing.smart_routing: served vs not served ─────────────────────────────
//
// `fetchGatewayConfig` used to fold `?? DEFAULT_SMART_ROUTING` into the routing
// section it returned. That is the coalesce the modality-map work forbade for
// itself, and it is worse for `smart_routing` than for `modality_map`: an
// unserved map coalesces to `{}` (nothing asserted), while an unserved
// `smart_routing` coalesced to a concrete `enabled: false` — a fabricated
// "classifier routing is off" that the desktop then spread back out on the next
// save of any OTHER routing field, because `PUT /v1/config { routing }` replaces
// the section wholesale and `RoutingConfig::smart_routing` is `#[serde(default)]`.
//
// The pass-through cannot PREVENT that erasure (omission and an explicit default
// deserialize identically on the gateway) — it makes it detectable, which is the
// same conclusion `routingViewIncludesModalityMap` reached and documents.

/**
 * Run `fetchGatewayConfig` against a canned `GET /api/gateway/config` body.
 *
 * A whole-`fetch` stub rather than a `request` mock: `request` is what applies
 * the JSON parse and the ok/!ok split this function rides on, and stubbing it
 * out would test a transport that does not exist.
 */
async function fetchWithBody(
	body: Parameters<typeof Response.json>[0]
): Promise<Awaited<ReturnType<typeof fetchGatewayConfig>>> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async () =>
			Response.json({
				auth: { api_keys: [], require_auth: false },
				providers: {
					anthropic: null,
					core: null,
					genai: null,
					local: null,
					openai: null,
					openrouter: null,
				},
				...z.record(z.string(), rpcJsonResponseSchema).parse(body),
			}),
		{
			preconnect: originalFetch.preconnect,
		}
	);
	try {
		return await fetchGatewayConfig({
			url: "http://127.0.0.1:7980",
			token: null,
			userJwt: null,
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
}

/** The routing section a current gateway serves, minus the field under test. */
const SERVED_ROUTING_BASE: GatewayRoutingConfig = {
	default_provider: "openai",
	model_map: {},
	fallback_chain: [],
	provider_tiers: {},
	modality_map: {},
	eval_routing: { enabled: false, candidates: [], explore_ratio: 0 },
};

describe("routingViewIncludesSmartRouting", () => {
	it("separates a gateway that omits the section from one that serves it off", () => {
		// Both render as "smart routing disabled" once a card coalesces. Only the
		// first means a save from this app would overwrite the operator's config.
		expect(routingViewIncludesSmartRouting({ ...SERVED_ROUTING_BASE })).toBe(
			false
		);
		expect(
			routingViewIncludesSmartRouting({
				...SERVED_ROUTING_BASE,
				smart_routing: DEFAULT_SMART_ROUTING,
			})
		).toBe(true);
	});

	it("matches the presence test the modality editor already relies on", () => {
		// One rule for the whole routing section, not two — the two predicates
		// disagreeing is how "which fields are safe to round-trip?" becomes a
		// per-field guess.
		const served = {
			...SERVED_ROUTING_BASE,
			smart_routing: DEFAULT_SMART_ROUTING,
		};
		expect(routingViewIncludesSmartRouting(served)).toBe(
			routingViewIncludesModalityMap(served)
		);
	});

	// The predecessor of this block asserted the OPPOSITE — that the dialog did
	// *not* consult this predicate — as a deliberate record of an unfinished fix,
	// with an instruction to replace it once the card grew a `served` state. The
	// card now has one, so the record is replaced by the guarantees it was standing
	// in for. Textual, because the `.tsx` cannot be imported here (same technique
	// as the buildBudgetRule guards above).

	it("is consulted by the dialog, on both the load edge and the save edge", () => {
		// Two call sites, not one, and the second is the one that matters. Checking
		// only at mount would leave the save writing a fabricated section whenever
		// the gateway restarts (or is swapped for an older build) between mount and
		// Save — the card re-fetches the config there anyway, so the fresh object is
		// what has to be tested.
		expect(gatewayDialogTsx).toContain("routingViewIncludesModalityMap(");
		const calls = gatewayDialogTsx.match(/routingViewIncludesSmartRouting\(/g);
		expect(calls?.length ?? 0).toBeGreaterThanOrEqual(2);
		expect(gatewayDialogTsx).toContain(
			"setServed(routingViewIncludesSmartRouting(cfg.routing))"
		);
		expect(gatewayDialogTsx).toContain(
			"if (!routingViewIncludesSmartRouting(cfg.routing))"
		);
	});

	it("refuses to save on anything but a positively served section", () => {
		// `served !== true`, NOT `served === false`. The three-state exists so a
		// gateway mid-first-fetch is not accused of being about to lose data; the
		// flip side is that `null` must not be treated as permission to write. A
		// `!draft || served === false` guard would let a save fire before the first
		// fetch resolved, writing DEFAULT_SMART_ROUTING over live config — the exact
		// destruction the predicate was introduced to prevent.
		expect(gatewayDialogTsx).toContain("if (!draft || served !== true) {");
		// And the controls are inert in that state, so the refusal is not a dead end
		// the user only discovers by pressing Save.
		expect(gatewayDialogTsx).toContain("|| served === false;");
	});

	it("tells the operator that an off-looking switch is an unreported one", () => {
		// The specific misreading this whole predicate exists to prevent: a switch
		// rendered off by DEFAULT_SMART_ROUTING is indistinguishable from a node
		// reporting "off". The copy has to name that, not merely say "unavailable",
		// or the user still believes they have read a fact about their config.
		expect(gatewayDialogTsx).toContain(
			"does not report its smart-routing config"
		);
		expect(gatewayDialogTsx).toContain(
			"shows off because nothing was reported"
		);
	});

	it("is exact on a gateway that serves the section switched off", () => {
		// `SmartRoutingConfig` is a plain struct on `RoutingView` (not an `Option`,
		// no `skip_serializing_if`), so a gateway that has the field ALWAYS emits
		// it — presence is a decision, not a heuristic.
		const view = rustBlock(
			gatewayApiConfigRs,
			GATEWAY_API_CONFIG_RS,
			"struct RoutingView"
		);
		expect(/\n\s*smart_routing:\s*SmartRoutingConfig,/.test(view)).toBe(true);
		expect(view).not.toContain("smart_routing: Option<");
	});
});

describe("fetchGatewayConfig preserves what the gateway did and did not serve", () => {
	it("keeps the safe ACP defaults when an older gateway omits the section", async () => {
		const cfg = await fetchWithBody({});
		expect(cfg.acp).toEqual(DEFAULT_GATEWAY_ACP);
	});

	it("keeps locked use disabled when an older gateway omits the section", async () => {
		const cfg = await fetchWithBody({});
		expect(cfg.computer_use).toEqual(DEFAULT_GATEWAY_COMPUTER_USE);
	});

	it("preserves the Gateway computer-use policy when it is served", async () => {
		const computerUse = { locked_use: true, security_key: true };
		const cfg = await fetchWithBody({ computer_use: computerUse });
		expect(cfg.computer_use).toEqual(computerUse);
	});

	it("preserves Gateway ACP policy and Core runtime status", async () => {
		const acp = {
			...DEFAULT_GATEWAY_ACP,
			active_agents: 1,
			auto_max_parallel_agents: 2,
			effective_max_parallel_agents: 2,
			max_parallel_agents: null,
		};
		const cfg = await fetchWithBody({ acp });
		expect(cfg.acp).toEqual(acp);
	});

	it("leaves smart_routing absent when the gateway omitted it", async () => {
		const cfg = await fetchWithBody({ routing: { ...SERVED_ROUTING_BASE } });
		expect(routingViewIncludesSmartRouting(cfg.routing)).toBe(false);
		// Spelled out separately: `in` would still be true for an explicit
		// `smart_routing: undefined`, and that value spreads into a PUT body as an
		// omitted key — indistinguishable on the wire from the fabricated default
		// this test exists to keep out.
		expect(Object.keys(cfg.routing)).not.toContain("smart_routing");
	});

	it("returns the served section verbatim, including a disabled one", async () => {
		const served = { ...DEFAULT_SMART_ROUTING, classifier_model: "router-1" };
		const cfg = await fetchWithBody({
			routing: { ...SERVED_ROUTING_BASE, smart_routing: served },
		});
		expect(cfg.routing.smart_routing).toEqual(served);
	});

	it("asserts no routing section at all when the response carries none", async () => {
		// The `DEFAULT_ROUTING` stand-in exists so the budgets/keys cards do not
		// throw; it must not claim a smart-routing state either.
		const cfg = await fetchWithBody({});
		expect(routingViewIncludesSmartRouting(cfg.routing)).toBe(false);
		expect(routingViewIncludesModalityMap(cfg.routing)).toBe(false);
	});

	it("still coalesces the sections whose controls bind straight to them", async () => {
		// The distinction is not "never default anything": `firewall.alert` and the
		// session budget back Selects that render uncontrolled on `undefined`. They
		// stay coalesced on purpose, and this pins that the routing change did not
		// quietly widen into them.
		const cfg = await fetchWithBody({});
		expect(cfg.firewall.alert).toBe("silent");
		expect(cfg.budgets.session).toEqual(DEFAULT_SESSION_BUDGET);
	});
});

describe("provider account contract", () => {
	it("keeps the desktop account fields aligned with the Gateway view", () => {
		const canonical = rustSource("apps/gateway/src/api/config.rs").match(
			/struct ProviderAccountView \{([\s\S]*?)\n\}/
		)?.[1];
		const desktop = readFileSync(
			join(import.meta.dir, "gateway.ts"),
			"utf8"
		).match(/interface GatewayProviderAccount \{([\s\S]*?)\n\}/)?.[1];
		expect(canonical).toBeDefined();
		expect(desktop).toBeDefined();
		const fields = (body: string) =>
			[...body.matchAll(/^\s*(\w+)\??:/gm)].map((match) => match[1]).sort();
		const viewFields = fields(canonical ?? "")
			.map((field) =>
				field === "drain_threshold_percent" ? "drainThresholdPercent" : field
			)
			.sort();
		expect(canonical).toContain('rename = "drainThresholdPercent"');
		expect(fields(desktop ?? "")).toEqual(viewFields);
		// The struct's own attribute lines are kept with its body: a `rename_all`
		// there would rename every wire key just as a field-level `rename` would.
		const policyDeclaration = rustSource(
			"crates/gateway/credentials/src/lib.rs"
		).match(
			/((?:#\[[^\n]*\]\n)*)pub struct ProviderAccountPolicy \{([\s\S]*?)\n\}/
		);
		const policy = policyDeclaration?.[2];
		expect(policy).toBeDefined();
		expect(policyDeclaration?.[1]).toContain("deny_unknown_fields");
		// The policy is what Core deserializes from the desktop's `accountPolicy`
		// (`SetProviderBody` in `apps/core/src/server/mod.rs`), and it denies
		// unknown fields. It carries no serde rename, so its wire keys ARE its Rust
		// field names, snake_case `drain_threshold_percent` included; only the
		// read-side view renames that field to `drainThresholdPercent`. Compare Rust
		// names to Rust names, and pin that the policy stays un-renamed, because
		// the desktop sends `drain_threshold_percent` (see "live provider account
		// save").
		expect(`${policyDeclaration?.[1]}${policy}`).not.toContain("rename");
		expect(
			[...(policy ?? "").matchAll(/^\s*pub (\w+):/gm)]
				.map((match) => match[1])
				.sort()
		).toEqual(
			fields(canonical ?? "").filter(
				(field) => field !== "id" && field !== "source"
			)
		);
	});
});

describe("live provider account save", () => {
	it("accepts a live application without requiring a restart", async () => {
		const original = globalThis.fetch;
		let sent: RyuJsonValue | undefined;
		globalThis.fetch = Object.assign(
			async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
				sent = rpcJsonResponseSchema.parse(JSON.parse(String(init?.body)));
				return new Response(
					JSON.stringify({
						success: true,
						accountsApplied: true,
						gateway_restarted: false,
					}),
					{ status: 200, headers: { "content-type": "application/json" } }
				);
			},
			{ preconnect: original.preconnect }
		);
		try {
			const account = {
				id: "a".repeat(64),
				name: "Primary",
				enabled: true,
				priority: 10,
			};
			await configureGatewayProviderAccount(
				{ url: "http://127.0.0.1:7980", token: null, userJwt: null },
				"fal",
				account
			);
			expect(sent).toEqual({
				provider: "fal",
				account_action: "configure",
				accountId: account.id,
				accountPolicy: {
					name: "Primary",
					enabled: true,
					priority: 10,
					drain_threshold_percent: null,
				},
			});
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("gateway response/request codecs accept every valid wire value", () => {
	it("accepts open ProviderId routing targets, not only ProviderKind", async () => {
		// Gateway `RoutingView` serializes `default_provider` / `fallback_chain` as
		// plain `ProviderId` strings; media and custom providers are valid.
		const cfg = await fetchWithBody({
			routing: {
				...SERVED_ROUTING_BASE,
				default_provider: "modal",
				fallback_chain: ["replicate", "fal", "my-custom-provider"],
			},
		});
		expect(cfg.routing.default_provider).toBe("modal");
		expect(cfg.routing.fallback_chain).toEqual([
			"replicate",
			"fal",
			"my-custom-provider",
		]);
	});

	it("sends eval, score and red-team bodies whose optional fields are undefined", async () => {
		// PromptStudio spreads optional fields as explicit `undefined`; the
		// request codec must tolerate what JSON.stringify omits instead of
		// failing locally before any request is made.
		const target = { url: "http://127.0.0.1:7980", token: null, userJwt: null };
		const sent: string[] = [];
		const transportStop = new Error("transport stub");
		const originalFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(
			(_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				sent.push(String(init?.body));
				return Promise.reject(transportStop);
			},
			{ preconnect: originalFetch.preconnect }
		);
		try {
			await expect(
				runGatewayEvals(target, {
					models: undefined,
					system_messages: undefined,
					judge_model: undefined,
				})
			).rejects.toThrow();
			await expect(
				scoreGatewayOutput(target, {
					response: "ok",
					model: undefined,
					expected: undefined,
				})
			).rejects.toThrow();
			await expect(
				runGatewayRedTeam(target, {
					agent_id: "agent-1",
					model: undefined,
					strategies: undefined,
				})
			).rejects.toThrow();
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(sent.map((body) => JSON.parse(body))).toEqual([
			{},
			{ response: "ok" },
			{ agent_id: "agent-1" },
		]);
	});
});

// ─── Routing pools ──────────────────────────────────────────────────────────

describe("routing pool list fields", () => {
	it("splits on commas and newlines, trims, drops blanks, and dedupes", () => {
		expect(parsePoolList(" *claude*, gpt-*,\n,gpt-* ,  ")).toEqual([
			"*claude*",
			"gpt-*",
		]);
		expect(parsePoolList("")).toEqual([]);
	});

	it("round-trips through the editable form", () => {
		const entries = ["*claude*", "gpt-*"];
		expect(parsePoolList(formatPoolList(entries))).toEqual(entries);
		expect(formatPoolList(undefined)).toBe("");
	});

	it("treats a pool with both lists empty as open", () => {
		expect(isOpenRoutePool({ allowed_models: [], allowed_providers: [] })).toBe(
			true
		);
		expect(
			isOpenRoutePool({ allowed_models: [], allowed_providers: ["core"] })
		).toBe(false);
	});
});

describe("saveAgentRoutePool", () => {
	const target = { url: "http://127.0.0.1:7980", token: null, userJwt: null };

	async function saveWith(
		served: Record<string, unknown>,
		save: () => Promise<void>
	): Promise<Record<string, unknown>[]> {
		const puts: Record<string, unknown>[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = Object.assign(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === "PUT") {
					puts.push(JSON.parse(String(init.body)));
					return Response.json({ ok: true });
				}
				// A gateway always serves `auth` and `providers` beside routing.
				return Response.json({
					auth: { api_keys: [], require_auth: false },
					providers: {
						anthropic: null,
						core: null,
						genai: null,
						local: null,
						openai: null,
						openrouter: null,
					},
					...served,
				});
			},
			{ preconnect: original.preconnect }
		);
		try {
			await save();
		} finally {
			globalThis.fetch = original;
		}
		return puts;
	}

	it("changes only this agent's entry and keeps the rest of routing", async () => {
		const served = {
			routing: {
				...SERVED_ROUTING_BASE,
				default_provider: "anthropic",
				smart_routing: {
					...DEFAULT_SMART_ROUTING,
					enabled: true,
					allowed_models: ["*claude*", "gpt-*"],
					agent_pools: {
						other: { allowed_models: ["gpt-*"], allowed_providers: [] },
						stale: { allowed_models: ["x"], allowed_providers: [] },
					},
				},
			},
		};
		const [put] = await saveWith(served, () =>
			saveAgentRoutePool(target, "bot", {
				allowed_models: ["*claude*"],
				allowed_providers: [],
			})
		);
		const routing = put?.routing as GatewayRoutingConfig;
		expect(routing.default_provider).toBe("anthropic");
		expect(routing.smart_routing?.enabled).toBe(true);
		expect(routing.smart_routing?.allowed_models).toEqual([
			"*claude*",
			"gpt-*",
		]);
		expect(routing.smart_routing?.agent_pools).toEqual({
			bot: { allowed_models: ["*claude*"], allowed_providers: [] },
			other: { allowed_models: ["gpt-*"], allowed_providers: [] },
			stale: { allowed_models: ["x"], allowed_providers: [] },
		});

		const [cleared] = await saveWith(served, () =>
			saveAgentRoutePool(target, "stale", {
				allowed_models: [],
				allowed_providers: [],
			})
		);
		const clearedRouting = cleared?.routing as GatewayRoutingConfig;
		expect(
			Object.keys(clearedRouting.smart_routing?.agent_pools ?? {})
		).toEqual(["other"]);
	});

	it("refuses to write when the gateway does not serve smart_routing", async () => {
		const puts = await saveWith(
			{ routing: { ...SERVED_ROUTING_BASE } },
			async () => {
				await expect(
					saveAgentRoutePool(target, "bot", {
						allowed_models: ["gpt-*"],
						allowed_providers: [],
					})
				).rejects.toBeInstanceOf(SmartRoutingUnavailableError);
			}
		);
		expect(puts).toEqual([]);
	});
});

describe("concurrent smart-routing saves", () => {
	const target = { url: "http://127.0.0.1:7981", token: null, userJwt: null };

	interface ConfigServer {
		/** Revisions sent with each PUT, in arrival order. */
		expectedRevisions: unknown[];
		/** Applied after the next read, as if another window saved meanwhile. */
		interleave?: (routing: GatewayRoutingConfig) => GatewayRoutingConfig;
		routing: GatewayRoutingConfig;
		staleWrites: number;
	}

	/**
	 * A gateway that keeps its routing between calls, bumps a revision on every
	 * write, and answers 409 to a write carrying a stale revision, like
	 * `PUT /v1/config`. Reads and writes yield, so overlapping saves interleave.
	 */
	async function withConfigServer(
		server: ConfigServer,
		run: () => Promise<void>
	): Promise<void> {
		let revision = 1;
		const revisionId = () => String(revision).padStart(64, "0");
		const original = globalThis.fetch;
		globalThis.fetch = Object.assign(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				await new Promise((resolve) => setTimeout(resolve, 1));
				if (init?.method === "PUT") {
					const body = JSON.parse(String(init.body)) as {
						expectedRevision?: unknown;
						routing: GatewayRoutingConfig;
					};
					server.expectedRevisions.push(body.expectedRevision);
					// An unrevisioned write is accepted, as the real gateway does.
					const stale =
						body.expectedRevision !== undefined &&
						body.expectedRevision !== revisionId();
					if (stale) {
						server.staleWrites += 1;
						return Response.json(
							{ error: "configuration changed" },
							{ status: 409 }
						);
					}
					server.routing = body.routing;
					revision += 1;
					return Response.json({ ok: true, configRevision: revisionId() });
				}
				const served = {
					auth: { api_keys: [], require_auth: false },
					configRevision: revisionId(),
					providers: {
						anthropic: null,
						core: null,
						genai: null,
						local: null,
						openai: null,
						openrouter: null,
					},
					routing: server.routing,
				};
				if (server.interleave) {
					server.routing = server.interleave(server.routing);
					server.interleave = undefined;
					revision += 1;
				}
				return Response.json(served);
			},
			{ preconnect: original.preconnect }
		);
		try {
			await run();
		} finally {
			globalThis.fetch = original;
		}
	}

	const servedRouting = (): GatewayRoutingConfig => ({
		...SERVED_ROUTING_BASE,
		smart_routing: { ...DEFAULT_SMART_ROUTING, agent_pools: {} },
	});

	it("keeps both an agent's pool and its override when saved together", async () => {
		const server: ConfigServer = {
			expectedRevisions: [],
			routing: servedRouting(),
			staleWrites: 0,
		};
		await withConfigServer(server, async () => {
			await Promise.all([
				saveAgentRoutePool(target, "bot", {
					allowed_models: ["*claude*"],
					allowed_providers: [],
				}),
				saveAgentRouteOverride(target, "bot", {
					...DEFAULT_SMART_ROUTING,
					enabled: true,
				}),
				saveAgentRoutePool(target, "other", {
					allowed_models: ["gpt-*"],
					allowed_providers: [],
				}),
			]);
		});
		const smart = server.routing.smart_routing;
		expect(smart?.agent_pools).toEqual({
			bot: { allowed_models: ["*claude*"], allowed_providers: [] },
			other: { allowed_models: ["gpt-*"], allowed_providers: [] },
		});
		expect(smart?.agent_routes?.bot?.enabled).toBe(true);
		expect(server.staleWrites).toBe(0);
		expect(server.expectedRevisions.every((r) => typeof r === "string")).toBe(
			true
		);
	});

	it("re-applies its change on top of a save made elsewhere meanwhile", async () => {
		const server: ConfigServer = {
			expectedRevisions: [],
			interleave: (routing) => ({
				...routing,
				default_provider: "anthropic",
				smart_routing: {
					...DEFAULT_SMART_ROUTING,
					...routing.smart_routing,
					agent_pools: {
						elsewhere: { allowed_models: ["x"], allowed_providers: [] },
					},
				},
			}),
			routing: servedRouting(),
			staleWrites: 0,
		};
		await withConfigServer(server, () =>
			saveAgentRoutePool(target, "bot", {
				allowed_models: ["*claude*"],
				allowed_providers: [],
			})
		);
		expect(server.staleWrites).toBe(1);
		expect(server.routing.default_provider).toBe("anthropic");
		expect(server.routing.smart_routing?.agent_pools).toEqual({
			bot: { allowed_models: ["*claude*"], allowed_providers: [] },
			elsewhere: { allowed_models: ["x"], allowed_providers: [] },
		});
	});
});

describe("sameGuardrailSections", () => {
	const firewall = {
		enabled: true,
		locked_fields: ["mode"],
		mode: "block",
	};

	it("ignores other sections, the revision and map key order", async () => {
		const base = await fetchWithBody({
			configRevision: "a".repeat(64),
			firewall,
			firewall_agent_overlays: {},
			firewall_org_overlays: {
				"org-a": { mode: "warn" },
				"org-b": { mode: "block" },
			},
			routing: { ...SERVED_ROUTING_BASE },
		});
		// A provider-key or routing save elsewhere moved the revision only.
		const fresh = await fetchWithBody({
			configRevision: "b".repeat(64),
			firewall: { mode: "block", locked_fields: ["mode"], enabled: true },
			firewall_agent_overlays: {},
			firewall_org_overlays: {
				"org-b": { mode: "block" },
				"org-a": { mode: "warn" },
			},
			routing: { ...SERVED_ROUTING_BASE, default_provider: "anthropic" },
		});
		expect(sameGuardrailSections(base, fresh)).toBe(true);
	});

	it("flags a firewall or overlay change saved elsewhere", async () => {
		const base = await fetchWithBody({
			firewall,
			firewall_agent_overlays: {},
			firewall_org_overlays: {},
		});
		const postureChanged = await fetchWithBody({
			firewall: { ...firewall, mode: "warn" },
			firewall_agent_overlays: {},
			firewall_org_overlays: {},
		});
		const overlayAdded = await fetchWithBody({
			firewall,
			firewall_agent_overlays: { "agent-1": { mode: "warn" } },
			firewall_org_overlays: {},
		});
		expect(sameGuardrailSections(base, postureChanged)).toBe(false);
		expect(sameGuardrailSections(base, overlayAdded)).toBe(false);
	});
});

describe("the guardrails save is wired to a fresh read", () => {
	it("compares the guardrail sections before writing with the read's revision", () => {
		expect(gatewayDialogTsx).toContain(
			"sameGuardrailSections(config, current)"
		);
		expect(gatewayDialogTsx).toContain(
			"expectedRevision: current.configRevision ?? undefined"
		);
		expect(gatewayDialogTsx).toContain(
			"withRoutingDraftEdits(cfg.routing, config, draft)"
		);
	});
});
