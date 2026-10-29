import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import {
	DEFAULT_SPEECH_PROCESSING_PREFS,
	parseSpeechProcessingPrefs,
	SPEECH_PROCESSING_ENGINES,
} from "./preferences.ts";
import { processSpeechText, type SpeechProcessingOptions } from "./voice.ts";

const TARGET = { token: null, url: "http://ryu.test" };

describe("Speech Processing preferences", () => {
	it("defaults to S1-mini with the published safe controls", () => {
		expect(parseSpeechProcessingPrefs(null)).toEqual(
			DEFAULT_SPEECH_PROCESSING_PREFS
		);
		expect(SPEECH_PROCESSING_ENGINES).toEqual([
			expect.objectContaining({
				engine: "s1-mini",
				label: "S1-mini by Superwhisper",
				model: "s1-mini-q4_k_m",
				sidecar: "llamacpp-speech",
			}),
		]);
	});

	it("rejects unknown values without losing the valid controls", () => {
		expect(
			parseSpeechProcessingPrefs(
				JSON.stringify({
					context: "calendar",
					engine: "chat",
					structure: "paragraphs",
					styling: "formal",
				})
			)
		).toEqual({
			...DEFAULT_SPEECH_PROCESSING_PREFS,
			styling: "formal",
		});
	});
});

describe("processSpeechText", () => {
	it("posts to the dedicated Core cleanup route", async () => {
		const originalFetch = globalThis.fetch;
		let requestUrl = "";
		const bodySchema = z.object({
			text: z.string(),
			engine: z.string(),
			styling: z.string(),
			structure: z.string(),
			context: z.string(),
		});
		let requestBody: z.output<typeof bodySchema> | undefined;
		globalThis.fetch = createFetchFixture(
			originalFetch,
			async (input, init) => {
				requestUrl = String(input);
				requestBody = bodySchema.parse(JSON.parse(String(init?.body)));
				return new Response(
					JSON.stringify({ text: "Send the report Friday." }),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					}
				);
			}
		);

		try {
			const options: SpeechProcessingOptions = {
				context: "general",
				engine: "s1-mini",
				structure: "prose",
				styling: "semi-formal",
			};
			expect(
				await processSpeechText(TARGET, "so um send the report Friday", options)
			).toBe("Send the report Friday.");
			expect(requestUrl).toBe("http://ryu.test/api/voice/speech-processing");
			expect(requestBody).toEqual({
				text: "so um send the report Friday",
				engine: "s1-mini",
				styling: "semi-formal",
				structure: "prose",
				context: "general",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
