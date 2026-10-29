// Applying a posture rewrites the Gateway firewall from a fresh read. The PUT
// must carry the revision of that read, so a concurrent firewall edit is
// refused with a conflict instead of silently overwritten.

import { beforeEach, expect, it, mock } from "bun:test";
import type { GatewayConfigPatch, GatewayFirewallConfig } from "./gateway.ts";

const REVISION = "b".repeat(64);
let firewall: GatewayFirewallConfig;
let patches: GatewayConfigPatch[] = [];
const preferences = new Map<string, string>();

mock.module("./gateway.ts", () => ({
	fetchGatewayConfig: () =>
		Promise.resolve({ configRevision: REVISION, firewall }),
	updateGatewayConfig: (_target: unknown, patch: GatewayConfigPatch) => {
		patches.push(patch);
		firewall = { ...firewall, ...patch.firewall };
		return Promise.resolve({ ok: true });
	},
}));
mock.module("./preferences.ts", () => ({
	getAgentGatewayRoutingMap: () => Promise.resolve({}),
	getClaudeGatewayRouting: () => Promise.resolve(null),
	getCodexGatewayRouting: () => Promise.resolve(null),
	getPreference: (_target: unknown, key: string) =>
		Promise.resolve(preferences.get(key) ?? null),
	setClaudeGatewayRouting: () => Promise.resolve(true),
	setCodexGatewayRouting: () => Promise.resolve(true),
	setPreference: (_target: unknown, key: string, value: string) => {
		preferences.set(key, value);
		return Promise.resolve(true);
	},
}));

const { applyGatewayPosture } = await import("./gateway-posture.ts");

beforeEach(() => {
	patches = [];
	preferences.clear();
	firewall = {
		enabled: true,
		scan_inbound: true,
		scan_outbound: true,
		log_detections: true,
		redact_pii: true,
		redact_secrets: true,
		wrap_untrusted_tool_results: true,
		policy: "sanitize",
		custom_patterns: [],
	};
});

it("sends the firewall with the revision it was derived from", async () => {
	const snapshot = await applyGatewayPosture(
		{ token: null, url: "https://posture.fixture" },
		"balanced"
	);
	expect(snapshot.resolved).toBe("balanced");
	expect(patches).toHaveLength(1);
	expect(patches[0]?.expectedRevision).toBe(REVISION);
	expect(patches[0]?.firewall?.policy).toBe("block");
});
