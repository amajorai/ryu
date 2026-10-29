import { describe, expect, test } from "bun:test";
import type { SaveNodeOnboardingStateInput } from "../src/lib/api/onboarding-profile.ts";
import type { PreparedAppUpdate } from "../src/lib/app-update-preparation.ts";
import {
	FixtureAddressSchema,
	NativeOnboardingFixtureStateSchema,
	NodeSetupFixtureSchema,
	PreferenceFixtureSchema,
	PreparedUpdateFixtureSchema,
	parseOnboardingFixtureState,
} from "./onboarding-fixture-contract.ts";

describe("onboarding proof fixture boundaries", () => {
	test("node choices retain the actual owner domain and allow empty context", () => {
		const input = {
			companyContext: "",
			companyKnowledgeEnabled: false,
			completed: false,
			setupKind: "personal",
		} satisfies SaveNodeOnboardingStateInput;
		expect(NodeSetupFixtureSchema.parse(input)).toEqual(input);
		expect(
			NodeSetupFixtureSchema.safeParse({ ...input, setupKind: "invalid" })
				.success
		).toBe(false);
		expect(
			NodeSetupFixtureSchema.safeParse({
				...input,
				companyKnowledgeEnabled: "false",
			}).success
		).toBe(false);
		expect(PreferenceFixtureSchema.parse({ value: "" })).toEqual({ value: "" });
		expect(PreferenceFixtureSchema.safeParse({ value: false }).success).toBe(
			false
		);
	});
	test("saved snapshots preserve copied own JSON keys and reject malformed state", () => {
		const raw =
			'{"nodeSetup":null,"quests":[{"__proto__":{"opaque":true}}],"rewardClaims":[],"agents":[],"activeOrg":"org-one","preferences":{"empty":"","__proto__":"retained"},"configured":false,"connections":[],"materialized":false,"cancelled":false,"onboardingSource":null}';
		const state = parseOnboardingFixtureState(raw);
		expect(Object.hasOwn(state.quests[0], "__proto__")).toBe(true);
		expect(state.preferences.empty).toBe("");
		expect(Object.hasOwn(state.preferences, "__proto__")).toBe(true);
		expect(() =>
			parseOnboardingFixtureState(
				raw.replace('"__proto__":"retained"', '"__proto__":0')
			)
		).toThrow();
		expect(() =>
			parseOnboardingFixtureState(
				raw.replace('"configured":false', '"configured":"false"')
			)
		).toThrow();
	});
	test("native update projection checks the signature fields and source union", () => {
		const update = {
			schemaVersion: 1,
			version: "0.2.0",
			signature: "fixture-signature",
			artifactFile: "fixture.zip",
			artifactSize: 100,
			source: { kind: "stable" },
		} satisfies PreparedAppUpdate;
		expect(PreparedUpdateFixtureSchema.parse(update)).toEqual(update);
		expect(
			PreparedUpdateFixtureSchema.safeParse({
				...update,
				source: { kind: "channel", channel: "foreign" },
			}).success
		).toBe(false);
		expect(
			PreparedUpdateFixtureSchema.safeParse({ ...update, signature: 5 }).success
		).toBe(false);
		expect(
			NativeOnboardingFixtureStateSchema.parse({
				autostart: false,
				tray: true,
				automatic: false,
				prepared: null,
				installed: false,
			}).prepared
		).toBe(null);
		expect(FixtureAddressSchema.safeParse("unix.sock").success).toBe(false);
		expect(
			FixtureAddressSchema.parse({
				address: "127.0.0.1",
				family: "IPv4",
				port: 5278,
			}).port
		).toBe(5278);
	});
});
