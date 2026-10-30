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
//
// The suites are split by topic into sibling `gateway-*.test.ts` files (inspector,
// budgets, modality routing, smart routing, config codecs, dialog wiring); the
// Rust-source parsers they share live in `gateway-test-support.ts`.

import { describe, expect, it } from "bun:test";
import {
	CLASSIFY_MODEL_ID,
	CLASSIFY_MODEL_PREFIX,
	CLASSIFY_SIDECAR_NAME,
	CLASSIFY_TIER_COPY,
	classifyTierCannotServeModel,
	classifyTierServable,
	deriveClassifyTierState,
} from "./gateway.ts";
import {
	CLASSIFY_SIDECAR_RS,
	classifySidecarRs,
	GATEWAY_CONFIG_RS,
	gatewayConfigRs,
	match,
	routerBuiltinPrefixes,
	rustStrConst,
} from "./gateway-test-support.ts";

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
