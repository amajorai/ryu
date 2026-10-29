import { describe, expect, it, spyOn } from "bun:test";
import {
	type GatewayJsonValue,
	gatewayJsonValueSchema,
} from "./gateway-json-contracts.ts";
import {
	fetchGatewaySpeechSettings,
	saveGatewayAnonymousSpeech,
} from "./speech-settings.ts";

const target = { url: "http://speech-fixture.invalid", token: null };
const revision = "a".repeat(64);
const edge = {
	provider: "edge-tts",
	anonymousConsumerOptIn: false,
	classification: "unofficial_anonymous_consumer",
	mode: "anonymous",
};

describe("anonymous speech settings boundary", () => {
	it("accepts legacy Edge nodes and rejects a malformed Translate projection", async () => {
		const fetch = spyOn(globalThis, "fetch");
		try {
			fetch.mockResolvedValueOnce(
				Response.json({
					speechSettingsSchema: 1,
					configRevision: revision,
					edgeTts: edge,
				})
			);
			expect(
				(await fetchGatewaySpeechSettings(target))?.googleTranslateTts
			).toBeUndefined();
			fetch.mockResolvedValueOnce(
				Response.json({
					speechSettingsSchema: 1,
					configRevision: revision,
					edgeTts: edge,
					googleTranslateTts: {
						...edge,
						provider: "google-translate-tts",
						anonymousConsumerOptIn: "true",
					},
				})
			);
			await expect(fetchGatewaySpeechSettings(target)).rejects.toThrow(
				"invalid speech settings"
			);
		} finally {
			fetch.mockRestore();
		}
	});
	it("sends the exact selected provider with the viewed revision", async () => {
		const fetch = spyOn(globalThis, "fetch");
		let captured: GatewayJsonValue;
		fetch.mockImplementation(
			Object.assign(
				(...[_input, init]: Parameters<typeof globalThis.fetch>) => {
					captured = gatewayJsonValueSchema.parse(
						JSON.parse(String(init?.body))
					);
					return Promise.resolve(
						Response.json({
							success: true,
							persisted: true,
							gateway_restarted: false,
							configRevision: revision,
							gateway_application: {
								status: "applied",
								requestedRevision: revision,
								appliedRevision: revision,
								epoch: { boot: "fixture-boot", sequence: 1 },
							},
						})
					);
				},
				{ preconnect: () => {} }
			)
		);
		try {
			await saveGatewayAnonymousSpeech(
				target,
				true,
				revision,
				"google-translate-tts"
			);
			expect(captured).toEqual({
				provider: "google-translate-tts",
				anonymousConsumerOptIn: true,
				expectedRevision: revision,
			});
			await saveGatewayAnonymousSpeech(target, false, revision);
			expect(captured).toEqual({
				anonymousConsumerOptIn: false,
				expectedRevision: revision,
			});
		} finally {
			fetch.mockRestore();
		}
	});
	it("treats only a missing legacy endpoint as unavailable and preserves transport errors", async () => {
		const fetch = spyOn(globalThis, "fetch");
		try {
			fetch.mockResolvedValueOnce(
				Response.json({ error: "Not found" }, { status: 404 })
			);
			expect(await fetchGatewaySpeechSettings(target)).toBeNull();
			fetch.mockResolvedValueOnce(
				Response.json({ error: "Unauthorized" }, { status: 401 })
			);
			await expect(fetchGatewaySpeechSettings(target)).rejects.toMatchObject({
				status: 401,
			});
			const offline = new Error("native network unavailable");
			fetch.mockRejectedValueOnce(offline);
			await expect(fetchGatewaySpeechSettings(target)).rejects.toBe(offline);
		} finally {
			fetch.mockRestore();
		}
	});
	it("keeps unsuccessful saves and superseded revision messages distinct", async () => {
		const fetch = spyOn(globalThis, "fetch");
		try {
			fetch.mockResolvedValueOnce(
				Response.json({ success: false, gateway_restarted: false })
			);
			await expect(
				saveGatewayAnonymousSpeech(target, true, revision)
			).rejects.toThrow("Speech settings were not saved.");
			fetch.mockResolvedValueOnce(
				Response.json({
					success: true,
					persisted: true,
					gateway_restarted: false,
					configRevision: revision,
					gateway_application: {
						status: "superseded",
						requestedRevision: revision,
						currentRevision: "b".repeat(64),
					},
				})
			);
			await expect(
				saveGatewayAnonymousSpeech(target, true, revision)
			).rejects.toThrow("a newer configuration replaced it");
		} finally {
			fetch.mockRestore();
		}
	});
});
