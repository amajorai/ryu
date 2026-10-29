import { describe, expect, it } from "bun:test";
import {
	PluginHostError,
	unknownHostMethodMessage,
	withLegacyBridgeFallback,
} from "./plugins.ts";

const METHOD = "safeActions.request";

function legacySpy() {
	const calls: number[] = [];
	return {
		calls,
		legacy: () => {
			calls.push(calls.length);
			return Promise.resolve("legacy");
		},
	};
}

describe("withLegacyBridgeFallback", () => {
	it("pins Core's unknown-method reply", () => {
		// Core: `plugin_bridge_api::unknown_method_reply_is_pinned`.
		expect(unknownHostMethodMessage(METHOD)).toBe(
			"unknown host method 'safeActions.request'"
		);
	});

	it("returns the bridge result without calling the legacy route", async () => {
		const { calls, legacy } = legacySpy();
		expect(
			await withLegacyBridgeFallback(
				METHOD,
				() => Promise.resolve("bridge"),
				legacy
			)
		).toBe("bridge");
		expect(calls).toHaveLength(0);
	});

	it("falls back once when an older Core does not know the method", async () => {
		const { calls, legacy } = legacySpy();
		const result = await withLegacyBridgeFallback(
			METHOD,
			() =>
				Promise.reject(
					new PluginHostError(
						"invalid_args",
						"unknown host method 'safeActions.request'"
					)
				),
			legacy
		);
		expect(result).toBe("legacy");
		expect(calls).toHaveLength(1);
	});

	it("never falls back on a refusal or another failure", async () => {
		for (const error of [
			new PluginHostError(
				"denied",
				"capability 'safe-actions:manage' not granted"
			),
			new PluginHostError("denied", "Safe Actions operator access denied"),
			new PluginHostError("not_found", "plugin not enabled"),
			new PluginHostError("server_error", "Safe Actions request failed"),
			new PluginHostError("invalid_args", "safeActions.request path is bad"),
			// The unknown-method text for a DIFFERENT method is not this one.
			new PluginHostError(
				"invalid_args",
				"unknown host method 'webhooks.secretGet'"
			),
			// The right text under the wrong code.
			new PluginHostError(
				"denied",
				"unknown host method 'safeActions.request'"
			),
			new Error("unknown host method 'safeActions.request'"),
		]) {
			const { calls, legacy } = legacySpy();
			const outcome = withLegacyBridgeFallback(
				METHOD,
				() => Promise.reject(error),
				legacy
			);
			await expect(outcome).rejects.toBe(error);
			expect(calls).toHaveLength(0);
		}
	});
});
