import { describe, expect, it } from "bun:test";
import { rpcJsonResponseSchema } from "@ryu/app-host/rpc";
import { z } from "zod";
import {
	DEFAULT_SMART_ROUTING,
	type GatewayRoutingConfig,
	MODALITIES,
	routingViewIncludesModalityMap,
	updateGatewayConfig,
	withModalityMapping,
	withRoutingDraftEdits,
} from "./gateway.ts";
import {
	GATEWAY_API_CONFIG_RS,
	GATEWAY_CONFIG_RS,
	gatewayApiConfigRs,
	gatewayConfigRs,
	routerRs,
	rustBlock,
	rustEnumWireVariants,
	rustStructFieldType,
	SERVED_ROUTING_BASE,
} from "./gateway-test-support.ts";

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
