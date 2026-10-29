import { describe, expect, it } from "bun:test";
import {
	DEFAULT_DICTATION_ASK_SHORTCUT,
	DEFAULT_DICTATION_POSTPROCESS_PROMPT,
	getAgentAutoRouting,
	getDictationPrefs,
	getKeybindings,
	getPreference,
	getVoiceInputPrefs,
	setPreference,
	subscribePreferenceChanges,
} from "./preferences.ts";

function mockFetch(response: () => Response): typeof fetch {
	const originalFetch = globalThis.fetch;
	return Object.assign(async () => response(), {
		preconnect: originalFetch.preconnect,
	});
}

describe("preference change notifications", () => {
	it("notifies in-process consumers after a successful save", async () => {
		const originalFetch = globalThis.fetch;
		const notifications: [string, string][] = [];
		const unsubscribe = subscribePreferenceChanges((key, value) => {
			notifications.push([key, value]);
		});

		try {
			globalThis.fetch = Object.assign(
				async () =>
					new Response(JSON.stringify({ ok: true }), {
						headers: { "content-type": "application/json" },
						status: 200,
					}),
				{ preconnect: originalFetch.preconnect }
			);

			expect(
				await setPreference(
					{ token: null, url: "http://ryu.test", userJwt: null },
					"ambient-elevator-enabled",
					"false"
				)
			).toBe(true);
			expect(notifications).toEqual([["ambient-elevator-enabled", "false"]]);
		} finally {
			unsubscribe();
			globalThis.fetch = originalFetch;
		}
	});

	it("returns null only for a missing preference", async () => {
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = mockFetch(
				() => new Response('{"error":"missing"}', { status: 404 })
			);
			expect(
				await getPreference(
					{ token: null, url: "http://ryu.test", userJwt: null },
					"missing-key"
				)
			).toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("preserves read and write failures", async () => {
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = mockFetch(
				() => new Response('{"error":"forbidden"}', { status: 403 })
			);
			await expect(
				getPreference(
					{ token: null, url: "http://ryu.test", userJwt: null },
					"protected-key"
				)
			).rejects.toMatchObject({ status: 403 });
			await expect(
				setPreference(
					{ token: null, url: "http://ryu.test", userJwt: null },
					"protected-key",
					"value"
				)
			).rejects.toMatchObject({ status: 403 });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

async function withStoredPreference(
	raw: string,
	assertion: () => Promise<void>
): Promise<void> {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = mockFetch(() =>
			Response.json({ key: "fixture", value: raw })
		);
		await assertion();
	} finally {
		globalThis.fetch = originalFetch;
	}
}
const target = { token: null, url: "http://ryu.test", userJwt: null };

describe("stored speech preference boundaries", () => {
	it("preserves missing cleanup defaults and legacy agent routing", async () => {
		await withStoredPreference(
			JSON.stringify({
				postProcess: null,
				ask: {
					agent: "  custom-agent  ",
					selection: { model: 123 },
					prompt: "  Keep whitespace  ",
				},
			}),
			async () => {
				const prefs = await getDictationPrefs(target);
				expect(prefs.postProcess.enabled).toBe(true);
				expect(prefs.postProcess.prompt).toBe(
					DEFAULT_DICTATION_POSTPROCESS_PROMPT
				);
				expect(prefs.ask.selection.agent_id).toBe("custom-agent");
				expect(prefs.ask.prompt).toBe("  Keep whitespace  ");
				expect(prefs.ask.shortcut).toBe(DEFAULT_DICTATION_ASK_SHORTCUT);
			}
		);
	});
	it("keeps valid voice fields when siblings need fallback", async () => {
		await withStoredPreference(
			JSON.stringify({
				enabled: "false",
				engine: "gateway",
				mode: "push-to-talk",
				model: null,
				shortcut: "  Alt+V  ",
			}),
			async () => {
				expect(await getVoiceInputPrefs(target)).toEqual({
					enabled: true,
					engine: "gateway",
					mode: "push-to-talk",
					model: "",
					shortcut: "Alt+V",
				});
			}
		);
	});
	it("preserves numeric routing coercion and filters malformed rules", async () => {
		await withStoredPreference(
			JSON.stringify({
				similarity_threshold: "0.7",
				cache_by_session: null,
				rules: [
					null,
					{ description: "valid", agent_id: "ryu" },
					{ description: "bad", agent_id: 1 },
				],
			}),
			async () => {
				const prefs = await getAgentAutoRouting(target);
				expect(prefs.similarity_threshold).toBe(0.7);
				expect(prefs.cache_by_session).toBe(true);
				expect(prefs.rules).toEqual([
					{ description: "valid", agent_id: "ryu" },
				]);
			}
		);
	});
	it("falls back to registered shortcuts for a corrupt override blob", async () => {
		await withStoredPreference(
			JSON.stringify({ "chat.send": { chord: "Mod+Enter" } }),
			async () => {
				expect(await getKeybindings(target)).toEqual({});
			}
		);
	});
});
