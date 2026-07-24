// Unit tests for the Store surface's section metadata + path→section resolver
// (surfaces/store/sections.ts). Pure data (no JSX): sectionFromPath is the
// deepest-recognized-segment mapping the Store shell uses to pick the initial tab
// from a route, STORE_SECTIONS is the tab-row order, and SEARCH_REALMS are the
// featureListLoader-composed search endpoints. One realm loader is driven against a
// swapped fetch (restored in afterEach) to prove the composition actually reads its
// configured container key.

import { afterEach, expect, test } from "bun:test";
import type { ApiTarget } from "@ryuhq/core-client/client";
import {
	SEARCH_REALMS,
	sectionFromPath,
	STORE_SECTIONS,
	type StoreSection,
} from "../surfaces/store/sections.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

// ── sectionFromPath ──────────────────────────────────────────────────────────

test("bare /store defaults to the plugins section", () => {
	expect(sectionFromPath("/store")).toBe("plugins");
});

test("deep /store/<section> links land on that section", () => {
	const cases: Record<string, StoreSection> = {
		"/store/plugins": "plugins",
		"/store/models": "models",
		"/store/skills": "skills",
		"/store/mcp": "mcp",
		"/store/agents": "agents",
		"/store/engines": "engines",
		"/store/finetune": "finetune",
	};
	for (const [path, section] of Object.entries(cases)) {
		expect(sectionFromPath(path)).toBe(section);
	}
});

test("standalone Integrate paths resolve to their section", () => {
	expect(sectionFromPath("/models")).toBe("models");
	expect(sectionFromPath("/skills")).toBe("skills");
	expect(sectionFromPath("/engines")).toBe("engines");
	expect(sectionFromPath("/finetune")).toBe("finetune");
});

test("segment aliases fold onto their canonical section", () => {
	// sidecars/apps → apps; tools → mcp; fine-tune → finetune.
	expect(sectionFromPath("/sidecars")).toBe("apps");
	expect(sectionFromPath("/apps")).toBe("apps");
	expect(sectionFromPath("/tools")).toBe("mcp");
	expect(sectionFromPath("/fine-tune")).toBe("finetune");
});

test("the deepest recognized segment wins over shallower ones", () => {
	// /store (→plugins) then /models: the later, deeper segment decides.
	expect(sectionFromPath("/store/models")).toBe("models");
});

test("an unrecognized trailing segment is skipped in favor of a known ancestor", () => {
	expect(sectionFromPath("/store/models/unknown-tail")).toBe("models");
});

test("a wholly unrecognized path falls back to plugins", () => {
	expect(sectionFromPath("/nonsense/here")).toBe("plugins");
	expect(sectionFromPath("")).toBe("plugins");
	expect(sectionFromPath("/")).toBe("plugins");
});

// ── STORE_SECTIONS ───────────────────────────────────────────────────────────

test("STORE_SECTIONS lists all eight sections with unique ids", () => {
	expect(STORE_SECTIONS).toHaveLength(8);
	const ids = STORE_SECTIONS.map((s) => s.id);
	expect(new Set(ids).size).toBe(ids.length);
});

test("the sidecar catalog is labelled 'Sidecars', not 'Apps' (stops claiming to be plugins)", () => {
	const apps = STORE_SECTIONS.find((s) => s.id === "apps");
	expect(apps?.label).toBe("Sidecars");
	// Plugins remains the first tab.
	expect(STORE_SECTIONS[0]).toEqual({ id: "plugins", label: "Plugins" });
});

// ── SEARCH_REALMS ────────────────────────────────────────────────────────────

test("every search realm exposes an id, label, and callable loader", () => {
	expect(SEARCH_REALMS.length).toBeGreaterThanOrEqual(5);
	for (const realm of SEARCH_REALMS) {
		expect(typeof realm.id).toBe("string");
		expect(typeof realm.label).toBe("string");
		expect(typeof realm.load).toBe("function");
	}
	// The plugins realm reads the real /api/plugins registry.
	const plugins = SEARCH_REALMS.find((r) => r.id === "plugins");
	expect(plugins?.label).toBe("Plugins");
});

test("the plugins realm loader reads the configured container key and title fields", async () => {
	let capturedUrl = "";
	globalThis.fetch = ((url: string | URL) => {
		capturedUrl = String(url);
		return Promise.resolve(
			new Response(
				JSON.stringify({ apps: [{ id: "com.ryu.mail", name: "Mail", version: "2.0.0" }] }),
				{ status: 200 }
			)
		);
	}) as unknown as typeof fetch;

	const plugins = SEARCH_REALMS.find((r) => r.id === "plugins");
	const target: ApiTarget = { url: "http://node:7980", token: null };
	const rows = await plugins?.load(target);
	expect(capturedUrl).toBe("http://node:7980/api/plugins");
	expect(rows?.[0]).toEqual({
		id: "com.ryu.mail",
		title: "Mail",
		subtitle: "com.ryu.mail",
		badge: "2.0.0",
	});
});
