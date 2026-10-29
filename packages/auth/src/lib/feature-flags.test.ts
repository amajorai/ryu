import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { WAITLIST_MANAGED_ONLY_FLAG } from "@ryuhq/protocol/feature-flags";
import {
	A_MAJOR_PASS_FLAG,
	APP_ROLLOUT_FLAGS,
	appRolloutFlag,
	appRolloutListed,
	CATALOG_AUDIENCE_RULE_ID,
	CLOUD_TASKS_BOX_BACKEND_FLAG,
	CLOUD_TASKS_SUBSCRIPTION_BACKENDS_FLAG,
	CLOUD_TASKS_SUBSCRIPTION_BACKENDS_HOSTED_OPENAI_FLAG,
	COMPUTE_SHARE_FLAG,
	catalogAudienceRule,
	closedStandaloneProductPages,
	DESKTOP_TRIAL_FLAG,
	defaultFeatureFlags,
	FAMILY_HUB_FLAG,
	FAMILY_SHARING_FLAG,
	FEATURE_FLAG_AUDIENCES,
	FEATURE_FLAGS,
	featureFlagByKey,
	featureFlagFallback,
	INTERFACE_OS_FLAG,
	MESSAGING_FLAG,
	PLUS_PUBLIC_FLAG,
	RESERVED_FEATURE_FLAG_TRAITS,
	resolveFeatureFlags,
	SERVICE_BOX_FLAG,
	SERVICE_GATEWAY_FLAG,
	SERVICE_HIRE_FLAG,
	SERVICE_MAIL_FLAG,
	SERVICE_SITES_FLAG,
	STANDALONE_PAYG_FLAG,
	STANDALONE_SERVICE_FLAGS,
	STANDALONE_SERVICE_SLUGS,
	standaloneProductPageOpen,
	standaloneServiceFlag,
	standaloneServiceListed,
	unlistedStandaloneServices,
	WORKSPACE_INTERFACES_FLAG,
} from "./feature-flags.ts";
import { featureFlagTargetRuleSchema } from "./feature-waitlists.ts";

/**
 * Fail-closed flags that ship ON by founder decision: Box launches on day one
 * (docs/box-per-session-desktop.md §12). They keep `failMode: "closed"` so the
 * kill switch and an explicit `false` still close every gated surface.
 */
const LAUNCHED_DEFAULT_ON_FLAGS: readonly string[] = [
	SERVICE_BOX_FLAG,
	CLOUD_TASKS_BOX_BACKEND_FLAG,
	// Plan-backed cloud tasks launched ON (2026-10-20): they run on the user's own
	// Claude or ChatGPT plan, so they carry no Ryu spend.
	CLOUD_TASKS_SUBSCRIPTION_BACKENDS_FLAG,
];

describe("FEATURE_FLAGS catalog invariants", () => {
	it("has no duplicate keys", () => {
		const keys = FEATURE_FLAGS.map((flag) => flag.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("defaults waitlist gating to all nodes and exposes its scope switch", () => {
		const definition = featureFlagByKey(WAITLIST_MANAGED_ONLY_FLAG.key);
		expect(definition).toMatchObject({
			defaultValue: false,
			exposure: "public",
			failMode: "closed",
		});
		expect(defaultFeatureFlags()[WAITLIST_MANAGED_ONLY_FLAG.key]).toBe(false);
	});

	it("keeps the desktop trial off until the beta ends", () => {
		expect(featureFlagByKey(DESKTOP_TRIAL_FLAG)).toMatchObject({
			defaultValue: false,
			exposure: "client",
			failMode: "closed",
		});
		expect(featureFlagFallback(DESKTOP_TRIAL_FLAG)).toBe(false);
	});

	it("keeps A Major Pass closed and public until it is explicitly opened", () => {
		expect(featureFlagByKey(A_MAJOR_PASS_FLAG)).toMatchObject({
			defaultValue: false,
			exposure: "public",
			failMode: "closed",
		});
		expect(featureFlagFallback(A_MAJOR_PASS_FLAG)).toBe(false);
	});

	it("keeps Plus private until its public flag is explicitly opened", () => {
		expect(PLUS_PUBLIC_FLAG).toBe("plans.plus_public");
		expect(featureFlagByKey(PLUS_PUBLIC_FLAG)).toMatchObject({
			defaultValue: false,
			exposure: "public",
			failMode: "closed",
		});
		expect(featureFlagFallback(PLUS_PUBLIC_FLAG)).toBe(false);
		expect(defaultFeatureFlags()[PLUS_PUBLIC_FLAG]).toBe(false);
		expect(
			resolveFeatureFlags({ overrides: { [PLUS_PUBLIC_FLAG]: true } })[
				PLUS_PUBLIC_FLAG
			]
		).toBe(true);
	});

	it("holds the OS desktop and the other workspace interfaces back by default", () => {
		for (const key of [INTERFACE_OS_FLAG, WORKSPACE_INTERFACES_FLAG]) {
			expect(featureFlagByKey(key)).toMatchObject({
				defaultValue: false,
				exposure: "client",
				failMode: "closed",
			});
			expect(featureFlagFallback(key)).toBe(false);
		}
	});

	it("ships family sharing dark, public and fail-closed", () => {
		// Even Max subscribers stay on the pre-family behaviour until the rollout
		// is explicitly opened; the public projection lets pricing render the bullet.
		expect(FAMILY_SHARING_FLAG).toBe("billing.family_sharing");
		expect(featureFlagByKey(FAMILY_SHARING_FLAG)).toMatchObject({
			defaultValue: false,
			exposure: "public",
			failMode: "closed",
		});
		expect(featureFlagFallback(FAMILY_SHARING_FLAG)).toBe(false);
		expect(defaultFeatureFlags()[FAMILY_SHARING_FLAG]).toBe(false);
	});

	it("flips family sharing only from a boolean override", () => {
		expect(
			resolveFeatureFlags({ overrides: { [FAMILY_SHARING_FLAG]: true } })[
				FAMILY_SHARING_FLAG
			]
		).toBe(true);
		expect(
			resolveFeatureFlags({ overrides: { [FAMILY_SHARING_FLAG]: "true" } })[
				FAMILY_SHARING_FLAG
			]
		).toBe(false);
	});

	it("ships the family hub dark, client-scoped and fail-closed", () => {
		// A discovery gate for the Family app listing, separate from the paid
		// family-sharing rollout so the two can move independently.
		expect(FAMILY_HUB_FLAG).toBe("family.hub");
		expect(FAMILY_HUB_FLAG).not.toBe(FAMILY_SHARING_FLAG);
		expect(featureFlagByKey(FAMILY_HUB_FLAG)).toMatchObject({
			defaultValue: false,
			exposure: "client",
			failMode: "closed",
		});
		expect(featureFlagFallback(FAMILY_HUB_FLAG)).toBe(false);
		expect(defaultFeatureFlags()[FAMILY_HUB_FLAG]).toBe(false);
		expect(
			resolveFeatureFlags({ overrides: { [FAMILY_HUB_FLAG]: true } })[
				FAMILY_HUB_FLAG
			]
		).toBe(true);
	});

	it("ships the Compute and Share tabs dark except for platform admins", () => {
		expect(COMPUTE_SHARE_FLAG).toBe("ui.compute_share");
		expect(featureFlagByKey(COMPUTE_SHARE_FLAG)).toMatchObject({
			audiences: ["platform_admin"],
			defaultValue: false,
			exposure: "client",
			failMode: "closed",
		});
		expect(featureFlagFallback(COMPUTE_SHARE_FLAG)).toBe(false);
		expect(
			resolveFeatureFlags({ overrides: { [COMPUTE_SHARE_FLAG]: true } })[
				COMPUTE_SHARE_FLAG
			]
		).toBe(true);
	});

	it("ships hosted Messaging dark, client-scoped and fail-closed", () => {
		// Sends and number leases spend organization credit; the router
		// re-evaluates the flag per org, and clients only hide entry points.
		expect(MESSAGING_FLAG).toBe("messaging.hosted");
		expect(featureFlagByKey(MESSAGING_FLAG)).toMatchObject({
			defaultValue: false,
			exposure: "client",
			failMode: "closed",
		});
		expect(featureFlagFallback(MESSAGING_FLAG)).toBe(false);
		expect(defaultFeatureFlags()[MESSAGING_FLAG]).toBe(false);
		expect(
			resolveFeatureFlags({ overrides: { [MESSAGING_FLAG]: true } })[
				MESSAGING_FLAG
			]
		).toBe(true);
	});

	it("ships one public, fail-closed flag per standalone service, off except launched Box", () => {
		expect(STANDALONE_SERVICE_FLAGS).toEqual({
			box: "services.box",
			connect: "services.connect",
			gateway: "services.gateway",
			hire: "services.hire",
			mail: "services.mail",
			messaging: "services.messaging",
			notify: "services.notify",
			passport: "services.passport",
			sites: "services.sites",
		});
		const keys = Object.values(STANDALONE_SERVICE_FLAGS);
		expect(new Set(keys).size).toBe(keys.length);
		for (const key of keys) {
			const launched = LAUNCHED_DEFAULT_ON_FLAGS.includes(key);
			expect(featureFlagByKey(key)).toMatchObject({
				defaultValue: launched,
				exposure: "public",
				failMode: "closed",
			});
			expect(featureFlagFallback(key)).toBe(launched);
			expect(defaultFeatureFlags()[key]).toBe(launched);
		}
		expect(featureFlagFallback(SERVICE_BOX_FLAG)).toBe(true);
		// The new keys never alias the existing standalone money/backend gates.
		expect(keys).not.toContain(STANDALONE_PAYG_FLAG);
		expect(keys).not.toContain(CLOUD_TASKS_BOX_BACKEND_FLAG);
		expect(featureFlagByKey(STANDALONE_PAYG_FLAG)).toMatchObject({
			defaultValue: false,
			exposure: "public",
		});
	});

	it("resolves standalone service slugs through the generic map", () => {
		expect(standaloneServiceFlag("box")).toBe(SERVICE_BOX_FLAG);
		expect(standaloneServiceFlag("sites")).toBe(SERVICE_SITES_FLAG);
		expect(standaloneServiceFlag("os")).toBeUndefined();
		expect(standaloneServiceFlag("constructor")).toBeUndefined();
		const slugs: string[] = STANDALONE_SERVICE_SLUGS.toSorted();
		expect(slugs).toEqual(Object.keys(STANDALONE_SERVICE_FLAGS).toSorted());
	});

	it("hides every unlaunched service until its flag is read as on", () => {
		// Never read: catalog defaults hide each standalone service except Box,
		// which is on by default.
		expect(unlistedStandaloneServices(null).toSorted()).toEqual(
			STANDALONE_SERVICE_SLUGS.filter((slug) => slug !== "box").toSorted()
		);
		expect(standaloneServiceListed("box", null)).toBe(true);
		// Malformed values fall back to the catalog default.
		expect(
			standaloneServiceListed("notify", { "services.notify": "true" })
		).toBe(false);
		expect(standaloneServiceListed("box", { [SERVICE_BOX_FLAG]: "true" })).toBe(
			true
		);
		// An explicit false (the kill switch's evaluated value) closes Box.
		expect(standaloneServiceListed("box", { [SERVICE_BOX_FLAG]: false })).toBe(
			false
		);
		// Unflagged products are never hidden.
		expect(standaloneServiceListed("os", null)).toBe(true);
		expect(standaloneProductPageOpen("cloud", {})).toBe(true);
	});

	it("switches each service independently", () => {
		const values = resolveFeatureFlags({
			overrides: { [SERVICE_BOX_FLAG]: true, [SERVICE_HIRE_FLAG]: true },
		});
		expect(standaloneServiceListed("box", values)).toBe(true);
		expect(standaloneServiceListed("hire", values)).toBe(true);
		expect(unlistedStandaloneServices(values).toSorted()).toEqual([
			"connect",
			"gateway",
			"mail",
			"messaging",
			"notify",
			"passport",
			"sites",
		]);
		expect(standaloneServiceListed("mail", { [SERVICE_MAIL_FLAG]: true })).toBe(
			true
		);
		expect(
			standaloneServiceListed("notify", { [SERVICE_MAIL_FLAG]: true })
		).toBe(false);
	});

	it("keeps the plan-included Gateway page open while its standalone listing is off", () => {
		expect(standaloneServiceListed("gateway", {})).toBe(false);
		expect(standaloneProductPageOpen("gateway", {})).toBe(true);
		expect(closedStandaloneProductPages({})).not.toContain("gateway");
		expect(closedStandaloneProductPages({}).toSorted()).toEqual([
			"connect",
			"hire",
			"mail",
			"messaging",
			"notify",
			"passport",
			"sites",
		]);
		expect(
			standaloneServiceListed("gateway", { [SERVICE_GATEWAY_FLAG]: true })
		).toBe(true);
	});

	it("gates the Sites Store listing on its service flag but never the Agent Inboxes app", () => {
		expect(appRolloutFlag("@ryu/sites")).toBe(SERVICE_SITES_FLAG);
		expect(appRolloutFlag("@ryu/mail")).toBeUndefined();
	});

	it("lists an app in a flag map only once its rollout flag reads true", () => {
		// Ungated apps are always listed; a gated app missing from the map takes
		// the closed catalog default.
		expect(appRolloutListed("@ryu/slides", null)).toBe(true);
		expect(appRolloutListed("@ryu/sites", null)).toBe(false);
		expect(
			appRolloutListed("@ryu/sites", { [SERVICE_SITES_FLAG]: "yes" })
		).toBe(false);
		expect(appRolloutListed("@ryu/sites", { [SERVICE_SITES_FLAG]: true })).toBe(
			true
		);
	});

	it("reserves organization_id so a client cannot claim an org rule", () => {
		const reserved: readonly string[] = RESERVED_FEATURE_FLAG_TRAITS;
		expect(reserved).toContain("organization_id");
	});

	it("maps gated app listings only to catalog flags", () => {
		expect(appRolloutFlag("@ryu/family")).toBe(FAMILY_HUB_FLAG);
		expect(appRolloutFlag("@ryu/expenses")).toBeUndefined();
		expect(appRolloutFlag("constructor")).toBeUndefined();
		for (const flagKey of Object.values(APP_ROLLOUT_FLAGS)) {
			expect(featureFlagByKey(flagKey)).toBeDefined();
		}
	});

	it("keeps Core-pre-installed apps out of the listing gate unless allowlisted", () => {
		// Installed rows are never filtered through APP_ROLLOUT_FLAGS, so an app
		// Core installs on every node cannot be hidden by a listing flag. An app
		// that is both must be named here with the reason, so the contradiction
		// stays visible.
		const allowlisted: Record<string, string> = {
			"@ryu/sites":
				"Pre-installed as the node's Sites control surface; the flag gates only the cloud marketplace listing and web showcase.",
		};
		const source = readFileSync(
			new URL("../../../../apps/core/src/plugins/builtins.rs", import.meta.url),
			"utf8"
		);
		const constants = new Map<string, string>();
		for (const match of source.matchAll(
			/pub const (\w+): &str = "(@ryu\/[\w-]+)";/g
		)) {
			constants.set(match[1] as string, match[2] as string);
		}
		const block =
			/pub const CORE_PREINSTALLED: &\[&str\] = &\[([\s\S]*?)\n\];/.exec(
				source
			)?.[1];
		expect(block).toBeDefined();
		const preinstalled = new Set<string>();
		for (const line of (block ?? "").split("\n")) {
			const entry = line.trim().replace(/,$/, "");
			const literal = /^"(@ryu\/[\w-]+)"$/.exec(entry)?.[1];
			const id = literal ?? constants.get(entry);
			if (id) {
				preinstalled.add(id);
			}
		}
		expect(preinstalled.size).toBeGreaterThan(10);
		for (const appId of Object.keys(APP_ROLLOUT_FLAGS)) {
			if (preinstalled.has(appId)) {
				expect(Object.keys(allowlisted)).toContain(appId);
			}
		}
		// The allowlist must not outlive the contradiction it documents.
		for (const appId of Object.keys(allowlisted)) {
			expect(preinstalled.has(appId)).toBe(true);
			expect(Object.hasOwn(APP_ROLLOUT_FLAGS, appId)).toBe(true);
		}
	});

	it("namespaces every key by surface so it cannot collide with FEATURES", () => {
		// `FEATURES` (features.ts) owns bare keys like `managed_inference`. The two
		// answer different questions and must never be readable as one axis.
		for (const flag of FEATURE_FLAGS) {
			expect(flag.key).toMatch(/^[a-z][a-z0-9_]*\.[a-z0-9_]+$/);
		}
	});

	it("defaults every fail-closed flag to off, except the launched flags", () => {
		// The whole point of `failMode: "closed"`: a client that has never read the
		// map must not show a money-adjacent surface. Box is the deliberate
		// exception: it launched ON, and spend is bounded server-side.
		for (const flag of FEATURE_FLAGS) {
			if (flag.failMode === "closed") {
				expect({ default: flag.defaultValue, key: flag.key }).toEqual({
					default: LAUNCHED_DEFAULT_ON_FLAGS.includes(flag.key),
					key: flag.key,
				});
			}
		}
	});
});

describe("featureFlagByKey / featureFlagFallback", () => {
	it("resolves a known key to its definition", () => {
		expect(featureFlagByKey("ui.managed_inference_card")?.failMode).toBe(
			"closed"
		);
	});

	it("returns undefined for an unknown key", () => {
		expect(featureFlagByKey("ui.does_not_exist")).toBeUndefined();
	});

	it("defaults ui.managed_inference_card to false", () => {
		expect(featureFlagFallback("ui.managed_inference_card")).toBe(false);
	});

	it("falls back to false for a key this build has never heard of", () => {
		expect(featureFlagFallback("ui.shipped_after_this_build")).toBe(false);
	});
});

describe("resolveFeatureFlags", () => {
	it("equals the catalog defaults with no overrides", () => {
		expect(resolveFeatureFlags()).toEqual(defaultFeatureFlags());
		expect(resolveFeatureFlags({ overrides: null })).toEqual(
			defaultFeatureFlags()
		);
		expect(resolveFeatureFlags({ overrides: {} })).toEqual(
			defaultFeatureFlags()
		);
	});

	it("flips a known key from an override", () => {
		const resolved = resolveFeatureFlags({
			overrides: { "ui.managed_inference_card": true },
		});
		expect(resolved["ui.managed_inference_card"]).toBe(true);
	});

	it("ignores unknown override keys so a new key never breaks an old client", () => {
		const resolved = resolveFeatureFlags({
			overrides: { "ui.a_key_from_a_future_release": true },
		});
		expect(resolved).toEqual(defaultFeatureFlags());
		expect(resolved["ui.a_key_from_a_future_release"]).toBeUndefined();
	});

	it("ignores a non-boolean override rather than coercing it", () => {
		// The override map comes from a hand-edited env var; `"true"` as a string
		// must not silently read as ON, and `null` must not read as OFF-by-cast.
		const overrides = {
			"ui.managed_inference_card": "true",
		};
		expect(resolveFeatureFlags({ overrides })).toEqual(defaultFeatureFlags());
	});

	it("applies global overrides for a null organizationId", () => {
		// The self-hosted individual (`scope: "user"`, no org) is EXACTLY the
		// population this flag targets. If null resolved to defaults the card would
		// never appear for them.
		const resolved = resolveFeatureFlags({
			organizationId: null,
			overrides: { "ui.managed_inference_card": true },
		});
		expect(resolved["ui.managed_inference_card"]).toBe(true);
	});

	it("returns a fresh map each call (callers must not share mutable state)", () => {
		const first = resolveFeatureFlags();
		first["ui.managed_inference_card"] = true;
		expect(resolveFeatureFlags()["ui.managed_inference_card"]).toBe(false);
	});
});

describe("audience declarations", () => {
	it("declares the cloud box backend flag on for everyone, closed, and carried to Core", () => {
		const definition = featureFlagByKey(CLOUD_TASKS_BOX_BACKEND_FLAG);
		expect(definition).toMatchObject({
			coreClaim: true,
			defaultValue: true,
			exposure: "client",
			failMode: "closed",
			key: "cloud_tasks.box_backend",
		});
		// The platform-admin audience is gone (design §12).
		expect(definition?.audiences).toBeUndefined();
		expect(featureFlagFallback(CLOUD_TASKS_BOX_BACKEND_FLAG)).toBe(true);
	});

	it("declares the subscription backends flag on, closed, and carried to Core", () => {
		expect(
			featureFlagByKey(CLOUD_TASKS_SUBSCRIPTION_BACKENDS_FLAG)
		).toMatchObject({
			coreClaim: true,
			defaultValue: true,
			exposure: "client",
			failMode: "closed",
			key: "cloud_tasks.subscription_backends",
		});
		expect(featureFlagFallback(CLOUD_TASKS_SUBSCRIPTION_BACKENDS_FLAG)).toBe(
			true
		);
	});

	it("keeps hosted OpenAI plan backends off, closed, and carried to Core", () => {
		expect(
			featureFlagByKey(CLOUD_TASKS_SUBSCRIPTION_BACKENDS_HOSTED_OPENAI_FLAG)
		).toMatchObject({
			coreClaim: true,
			defaultValue: false,
			exposure: "client",
			failMode: "closed",
			key: "cloud_tasks.subscription_backends_hosted_openai",
		});
		expect(
			featureFlagFallback(CLOUD_TASKS_SUBSCRIPTION_BACKENDS_HOSTED_OPENAI_FLAG)
		).toBe(false);
	});

	it("uses only known audiences in the catalog", () => {
		const known = new Set<string>(FEATURE_FLAG_AUDIENCES);
		for (const flag of FEATURE_FLAGS) {
			for (const audience of flag.audiences ?? []) {
				expect(known.has(audience)).toBe(true);
			}
		}
	});

	it("reserves the audience and identity trait keys", () => {
		const reserved: readonly string[] = RESERVED_FEATURE_FLAG_TRAITS;
		for (const key of [
			"audience",
			"group",
			"groups",
			"org_role",
			"plan",
			"platform_admin",
		]) {
			expect(reserved).toContain(key);
		}
	});

	it("synthesizes one valid catalog audience rule", () => {
		const rule = catalogAudienceRule({ audiences: ["platform_admin"] });
		expect(rule).toEqual({
			allocationPercent: 100,
			conditions: [
				{ attribute: "audience", operator: "in", value: ["platform_admin"] },
			],
			enabled: true,
			id: CATALOG_AUDIENCE_RULE_ID,
			name: "Catalog audience",
		});
		expect(featureFlagTargetRuleSchema.safeParse(rule).success).toBe(true);
	});

	it("returns null for flags without audiences", () => {
		expect(catalogAudienceRule({})).toBeNull();
		expect(catalogAudienceRule({ audiences: [] })).toBeNull();
		const definition = featureFlagByKey("ui.managed_inference_card");
		expect(definition && catalogAudienceRule(definition)).toBeNull();
	});
});
