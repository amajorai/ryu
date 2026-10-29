import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { SaveNodeOnboardingStateInput } from "../src/lib/api/onboarding-profile.ts";
import type { PreparedAppUpdate } from "../src/lib/app-update-preparation.ts";
import {
	type ProofJsonRecord,
	type ProofJsonValue,
	parseProofJson,
	parseProofJsonRecord,
} from "./fixture-json.ts";

export const NodeSetupFixtureSchema = z
	.object({
		companyContext: z.string(),
		companyKnowledgeEnabled: z.boolean(),
		completed: z.boolean(),
		setupKind: z.enum(["personal", "team"]),
	})
	.catchall(z.json()) satisfies z.ZodType<SaveNodeOnboardingStateInput>;
export function parseNodeSetupFixture(
	value: ProofJsonRecord | null
): z.infer<typeof NodeSetupFixtureSchema> {
	NodeSetupFixtureSchema.parse(value);
	// SAFETY: The owner's complete node setup fields and every extra JSON field were checked above.
	return value as z.infer<typeof NodeSetupFixtureSchema>;
}
export const OnboardingSourceFixtureSchema = z.object({ source: z.string() });
export const OrganizationFixtureSchema = z.object({
	organizationId: z.string(),
});
export const ConnectionInputFixtureSchema = z.object({
	toolkit: z.string(),
	access_level: z.string(),
});
export const PreferenceFixtureSchema = z.object({ value: z.string() });
export const FixtureAddressSchema = z.object({
	address: z.string(),
	family: z.string(),
	port: z.number(),
}) satisfies z.ZodType<AddressInfo>;
const JsonRecordSchema = z.record(z.string(), z.json());
export const OnboardingFixtureStateSchema = z.object({
	nodeSetup: NodeSetupFixtureSchema.nullable(),
	quests: z.array(JsonRecordSchema),
	rewardClaims: z.array(z.json()),
	agents: z.array(JsonRecordSchema),
	activeOrg: z.string(),
	preferences: z.record(z.string(), z.string()),
	configured: z.boolean(),
	connections: z.array(
		z.object({
			id: z.string(),
			toolkit: z.string(),
			active: z.boolean(),
			status: z.string(),
			access_level: z.string(),
		})
	),
	materialized: z.boolean(),
	cancelled: z.boolean(),
	onboardingSource: z.string().nullable(),
});
export type OnboardingFixtureState = z.infer<
	typeof OnboardingFixtureStateSchema
>;
export function parseOnboardingFixtureState(
	raw: string
): OnboardingFixtureState {
	const value = parseProofJsonRecord(raw);
	OnboardingFixtureStateSchema.parse(value);
	const preferences = parseProofJsonRecord(JSON.stringify(value.preferences));
	for (const preference of Object.values(preferences)) {
		z.string().parse(preference);
	}
	// SAFETY: Every state field was checked above; retain the original own JSON keys in copied requests.
	return value as OnboardingFixtureState;
}
const UpdateSourceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("stable") }),
	z.object({
		kind: z.literal("channel"),
		channel: z.enum(["beta", "canary", "nightly"]),
	}),
	z.object({
		kind: z.literal("tag"),
		channel: z.enum(["beta", "stable"]),
		tag: z.string(),
	}),
]);
export const PreparedUpdateFixtureSchema = z.object({
	schemaVersion: z.literal(1),
	version: z.string(),
	signature: z.string(),
	artifactFile: z.string(),
	artifactSize: z.number(),
	source: UpdateSourceSchema,
}) satisfies z.ZodType<PreparedAppUpdate>;
export const NativeOnboardingFixtureStateSchema = z.object({
	autostart: z.boolean(),
	tray: z.boolean(),
	automatic: z.boolean(),
	prepared: PreparedUpdateFixtureSchema.nullable(),
	installed: z.boolean(),
});
export type NativeOnboardingFixtureState = z.infer<
	typeof NativeOnboardingFixtureStateSchema
>;
export function parseNativeOnboardingFixtureState(
	raw: string
): NativeOnboardingFixtureState {
	return NativeOnboardingFixtureStateSchema.parse(parseProofJson(raw));
}
export type FixtureResponse = ProofJsonValue | undefined;
