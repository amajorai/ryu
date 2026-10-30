import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { GatewayConfigPatchInput, InspectorConfig } from "./gateway.ts";
import {
	CLASSIFY_MODEL_ID,
	CLASSIFY_MODEL_PREFIX,
	DEFAULT_INSPECTOR,
	type GatewayConfigPatch,
	updateGatewayConfig,
	withResolvedInspectorModels,
} from "./gateway.ts";
import {
	GATEWAY_CONFIG_RS,
	gatewayConfigRs,
	parseInspectorDefaultImpl,
	rustBlock,
	rustEnumDefaultWireValue,
	rustInspectorDefault,
} from "./gateway-test-support.ts";

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
