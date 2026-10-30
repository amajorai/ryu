import { describe, expect, it } from "bun:test";
import {
	ALERT_TIERS,
	buildBudgetRule,
	CLASSIFY_MODEL_ID,
	DEFAULT_INSPECTOR,
	DEFAULT_SESSION_BUDGET,
	type GatewayConfigPatch,
	withAgentBudget,
	withResolvedInspectorModels,
} from "./gateway.ts";
import {
	BUDGET_RS,
	budgetRs,
	CONTRACTS_RS,
	CORE_POLICY_ALERTS_RS,
	contractsRs,
	corePolicyAlertsRs,
	GATEWAY_CONFIG_RS,
	gatewayConfigRs,
	gatewayDialogSource,
	match,
	rustBlock,
	rustEnumWireVariants,
	rustSource,
	rustStructFieldType,
} from "./gateway-test-support.ts";

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
	const dialog = gatewayDialogSource();

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
