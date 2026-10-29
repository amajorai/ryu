import { describe, expect, it } from "bun:test";
import type { GatewayProviderApplication } from "./gateway.ts";
import {
	type GatewayJsonValue,
	gatewayJsonValueSchema,
} from "./gateway-json-contracts.ts";
import {
	type GatewaySpeechSettings,
	gatewaySpeechEditResultSchema,
	gatewaySpeechSettingsSchema,
} from "./speech-settings-contracts.ts";

interface SpeechSettingsFixture extends GatewaySpeechSettings {
	metadata: GatewayJsonValue;
}

const revision = "a".repeat(64);
const edgeTts = {
	anonymousConsumerOptIn: false,
	classification: "unofficial_anonymous_consumer",
	mode: "anonymous",
	provider: "edge-tts",
} satisfies GatewaySpeechSettings["edgeTts"];

describe("native speech settings records", () => {
	it("retains complete settings and additive metadata by identity", () => {
		const record = {
			configRevision: revision,
			edgeTts,
			speechSettingsSchema: 1,
			metadata: gatewayJsonValueSchema.parse(
				JSON.parse('{"__proto__":{"future":true}}')
			),
		} satisfies SpeechSettingsFixture;
		const parsed = gatewaySpeechSettingsSchema.parse(record);
		expect(parsed).toBe(record);
		expect(parsed.edgeTts).toBe(edgeTts);
		expect(
			gatewaySpeechSettingsSchema.safeParse({
				...record,
				googleTranslateTts: undefined,
			}).success
		).toBe(false);
		expect(
			gatewaySpeechSettingsSchema.safeParse({
				...record,
				configRevision: revision.toUpperCase(),
			}).success
		).toBe(false);
		expect(
			gatewaySpeechSettingsSchema.safeParse({
				...record,
				edgeTts: { ...edgeTts, mode: "authenticated" },
			}).success
		).toBe(false);
	});
	it("validates all six native revision receipt statuses", () => {
		const epoch = { boot: "native-boot", sequence: 7 };
		const applications = [
			{
				status: "applied",
				requestedRevision: revision,
				appliedRevision: revision,
				epoch,
			},
			{
				status: "already_applied",
				requestedRevision: revision,
				appliedRevision: revision,
				epoch,
			},
			{
				status: "superseded",
				requestedRevision: revision,
				currentRevision: "b".repeat(64),
			},
			{
				status: "failed",
				requestedRevision: revision,
				activeRevision: null,
				code: "invalid_config",
			},
			{ status: "offline", requestedRevision: revision },
			{ status: "unmanaged", requestedRevision: revision },
		] satisfies GatewayProviderApplication[];
		for (const application of applications) {
			const result = {
				success: true,
				persisted: true,
				gateway_restarted: false,
				configRevision: revision,
				gateway_application: application,
				metadata: { future: true },
			};
			expect(gatewaySpeechEditResultSchema.parse(result)).toBe(result);
		}
		expect(
			gatewaySpeechEditResultSchema.safeParse({
				success: true,
				gateway_restarted: false,
				gateway_application: {
					...applications[0],
					epoch: { boot: "native-boot", sequence: "7" },
				},
			}).success
		).toBe(false);
		expect(
			gatewaySpeechEditResultSchema.safeParse({
				success: true,
				gateway_restarted: false,
				gateway_application: {
					status: "applied",
					requestedRevision: revision,
					appliedRevision: revision,
				},
			}).success
		).toBe(false);
	});
	it("keeps genuine legacy restart receipts and unsuccessful save replies", () => {
		const legacy = {
			success: true,
			persisted: true,
			gateway_restarted: true,
			configRevision: revision,
		};
		expect(gatewaySpeechEditResultSchema.parse(legacy)).toBe(legacy);
		expect(
			gatewaySpeechEditResultSchema.parse({
				success: false,
				gateway_restarted: false,
			}).success
		).toBe(false);
	});
});
