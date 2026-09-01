// apps/desktop/src/lib/api/mesh.test.ts
//
// Unit tests for the wire-facing helpers in `mesh.ts` — the ingress-kind label
// map, the BYO ("own-relay") predicate, and the mesh `enabled` default that
// every mesh-dependent settings surface gates on.
//
// These three are pure functions on purpose: they encode a contract with Core
// (kebab-case `IngressKind::as_str()`, `ryu_mesh::is_enabled()`), and this repo
// has no component-test harness, so a helper left inline in a `.tsx` cannot be
// covered at all.

import { describe, expect, test } from "bun:test";
import {
	INGRESS_KIND_OWN_RELAY,
	INGRESS_LABELS,
	INGRESS_URL_PREF,
	ingressLabel,
	isOwnRelayKind,
	MESH_BACKEND_HEADSCALE,
	MESH_BACKEND_TAILCAT,
	normalizeMeshStatus,
	parseMeshBackend,
} from "./mesh.ts";

describe("ingressLabel", () => {
	// Core emits kebab-case (`IngressKind::as_str()`). The map was keyed
	// snake_case, so every multi-word kind fell through to the title-caser and
	// rendered "Ryu-relay" / "Own-relay" instead of its friendly name.
	test("labels every kind Core can emit, in its kebab wire form", () => {
		expect(ingressLabel("ryu-relay")).toBe("Ryu Relay (managed)");
		expect(ingressLabel("tailscale-funnel")).toBe("Tailscale Funnel");
		expect(ingressLabel("cloudflared")).toBe("Cloudflare Tunnel");
		expect(ingressLabel("own-relay")).toBe("Self-hosted relay");
	});

	test("no label key contains an underscore (Core never emits snake_case)", () => {
		for (const key of Object.keys(INGRESS_LABELS)) {
			expect(key).not.toContain("_");
		}
	});

	test("title-cases an unknown kebab-case kind without leaving a hyphen", () => {
		expect(ingressLabel("ngrok-tunnel")).toBe("Ngrok Tunnel");
	});

	test("title-cases an unknown snake_case kind too", () => {
		expect(ingressLabel("some_new_backend")).toBe("Some New Backend");
	});

	test("empty kind yields an empty label rather than throwing", () => {
		expect(ingressLabel("")).toBe("");
	});
});

describe("isOwnRelayKind", () => {
	test("matches the canonical kind Core emits", () => {
		expect(isOwnRelayKind(INGRESS_KIND_OWN_RELAY)).toBe(true);
	});

	test("matches the aliases Core's FromStr accepts, case-insensitively", () => {
		expect(isOwnRelayKind("ownrelay")).toBe(true);
		expect(isOwnRelayKind("own_relay")).toBe(true);
		expect(isOwnRelayKind(" Own-Relay ")).toBe(true);
	});

	test("does not match any other backend", () => {
		expect(isOwnRelayKind("ryu-relay")).toBe(false);
		expect(isOwnRelayKind("tailscale-funnel")).toBe(false);
		expect(isOwnRelayKind("cloudflared")).toBe(false);
		expect(isOwnRelayKind("")).toBe(false);
	});

	test("the URL pref key matches Core's INGRESS_URL_PREF", () => {
		expect(INGRESS_URL_PREF).toBe("webhook.ingress.url");
	});
});

describe("normalizeMeshStatus enabled gate", () => {
	// The settings surfaces that configure the mesh hide themselves when mesh is
	// not relevant. `enabled` is the gate, so its default must be the safe one:
	// an older Core that omits the field must read as "no mesh", not "mesh on".
	test("defaults enabled to false when Core omits the field", () => {
		expect(normalizeMeshStatus({}).enabled).toBe(false);
	});

	test("reports enabled:false verbatim (the mesh-off 200 response)", () => {
		expect(normalizeMeshStatus({ enabled: false, peers: [] }).enabled).toBe(
			false
		);
	});

	test("reports enabled:true when Core says the mesh is opted in", () => {
		expect(
			normalizeMeshStatus({ enabled: true, reachable: true }).enabled
		).toBe(true);
	});
});

describe("Tailcat backend", () => {
	test("uses Tailcat for an unconfigured fresh node", () => {
		expect(parseMeshBackend(null)).toBe(MESH_BACKEND_TAILCAT);
		expect(parseMeshBackend("unknown-backend")).toBe(MESH_BACKEND_TAILCAT);
	});

	test("keeps a legacy Headscale URL as the implicit backend", () => {
		expect(parseMeshBackend(null, "https://headscale.example.com")).toBe(
			MESH_BACKEND_HEADSCALE
		);
	});

	test("normalizes and labels the point-to-point backend", () => {
		expect(parseMeshBackend(" tailcat ")).toBe(MESH_BACKEND_TAILCAT);
		expect(
			normalizeMeshStatus({
				backend: MESH_BACKEND_TAILCAT,
				enabled: true,
				reachable: true,
				tailcat_address: "tcExampleToken",
			})
		).toMatchObject({
			backend: MESH_BACKEND_TAILCAT,
			tailcatAddress: "tcExampleToken",
		});
	});
});
