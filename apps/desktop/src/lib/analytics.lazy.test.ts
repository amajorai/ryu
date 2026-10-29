import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The PostHog SDK is imported only when an event is tracked after
// initAnalytics(). Until then events wait in a small queue; the opt-out gate
// applies before, during and after the import, and the egress log records an
// event only once it is handed to the client. `analytics.ts` reads the key when first evaluated, so this
// suite sets it first and runs in its own process.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register({ url: "http://localhost/" });
}
process.env.VITE_POSTHOG_KEY = "phc_test";
localStorage.clear();

const calls: string[] = [];
const captured: unknown[][] = [];
const initOptions: Record<string, unknown>[] = [];
const fake = {
	capture: (...args: unknown[]) => {
		captured.push(args);
	},
	has_opted_out_capturing: () => false,
	identify: () => {
		calls.push("identify");
	},
	init: (_key: string, options: Record<string, unknown>) => {
		calls.push("init");
		initOptions.push(options);
	},
	opt_in_capturing: () => {
		calls.push("opt_in");
	},
	opt_out_capturing: () => {
		calls.push("opt_out");
	},
	register: (properties: Record<string, unknown>) => {
		calls.push(`register:${String(properties.$source)}`);
	},
};
mock.module("posthog-js", () => ({ default: fake }));

const {
	analyticsReady,
	getEgressLog,
	initAnalytics,
	setAnalyticsEnabled,
	track,
} = await import("./analytics.ts");

test("events wait for the lazily loaded SDK, and the opt-out holds across the load", async () => {
	// Before initAnalytics(): logged as today, never queued, no SDK.
	track({ event: "chat_started" });
	expect(getEgressLog().map((entry) => entry.event)).toEqual(["chat_started"]);
	expect(await analyticsReady()).toBe(false);
	expect(calls).toEqual([]);

	initAnalytics();
	// initAnalytics() alone loads nothing: the SDK waits for the first event.
	await Promise.resolve();
	expect(calls).toEqual([]);
	track({ event: "agent_installed", agent_id: "dropped" });
	// Opting out before the SDK arrives drops what was queued...
	setAnalyticsEnabled(false);
	track({ event: "feature_enabled", section: "never-sent" });
	setAnalyticsEnabled(true);
	track({ event: "agent_installed", agent_id: "kept" });
	expect(captured).toEqual([]);
	// Queued events are not in the egress log yet; the dropped ones never are.
	expect(getEgressLog().map((entry) => entry.event)).toEqual(["chat_started"]);

	expect(await analyticsReady()).toBe(true);
	// ...and the client starts with the gate as it stands, replaying the toggle.
	expect(calls).toEqual(["init", "register:desktop", "opt_in"]);
	expect(initOptions[0]?.opt_out_capturing_by_default).toBe(false);
	expect(initOptions[0]?.autocapture).toBe(false);
	expect(captured).toEqual([["agent_installed", { agent_id: "kept" }]]);
	expect(getEgressLog().map((entry) => entry.props)).toEqual([
		{},
		{ agent_id: "kept" },
	]);

	// Once live, events go straight to the client and the toggle is immediate.
	track({ event: "chat_started" });
	expect(captured).toHaveLength(2);
	setAnalyticsEnabled(false);
	track({ event: "chat_started" });
	expect(captured).toHaveLength(2);
	expect(calls.at(-1)).toBe("opt_out");
	expect(calls).not.toContain("identify");
	expect(getEgressLog().map((entry) => entry.event)).toEqual([
		"chat_started",
		"agent_installed",
		"chat_started",
	]);
});
