// Unit tests for the surface router (workspace/router.ts) — the single path→
// Surface registry the desktop-mirrored shell resolves every tab through. Importing
// the module registers all built-in surfaces as a side effect, so these tests
// assert on that populated registry (path ownership, resolution, prefix matching)
// and on registerSurface's id-idempotency guard, which protects against a
// double-import registering a surface twice.

import { expect, test } from "bun:test";
import {
	listSurfaces,
	registerSurface,
	resolveSurface,
	type SurfaceModule,
} from "../workspace/router.ts";

// ── resolveSurface ─────────────────────────────────────────────────────────────

test("resolveSurface maps the home chat path to the chat surface", () => {
	expect(resolveSurface("/chat")?.id).toBe("chat");
});

test("resolveSurface resolves each canonical nav path to a distinct surface", () => {
	const cases: Record<string, string> = {
		"/home": "home",
		"/agents": "agents",
		"/teams": "teams",
		"/store": "store",
		"/models": "store-models",
		"/skills": "store-skills",
		"/engines": "store-engines",
		"/library": "library",
		"/spaces": "spaces",
		"/tools": "tools",
		"/workflows": "workflows",
		"/calendar": "calendar",
		"/timeline": "timeline",
		"/monitors": "monitors",
		"/tasks": "tasks",
		"/meetings": "meetings",
		"/inbox": "inbox",
		"/downloads": "downloads",
		"/setup": "setup",
	};
	for (const [path, id] of Object.entries(cases)) {
		expect(resolveSurface(path)?.id).toBe(id);
	}
});

test("resolveSurface returns undefined for an unowned path", () => {
	expect(resolveSurface("/does/not/exist")).toBeUndefined();
});

test("resolveSurface supports prefix (deep-link) matches", () => {
	// The agents surface owns both /agents and /agents/<id>.
	const exact = resolveSurface("/agents");
	const deep = resolveSurface("/agents/abc-123");
	expect(exact?.id).toBe("agents");
	expect(deep?.id).toBe("agents");
});

// ── listSurfaces ───────────────────────────────────────────────────────────────

test("listSurfaces returns every registered surface with a unique id", () => {
	const surfaces = listSurfaces();
	// Chat + the 6 builder bundles register at least 17 surfaces.
	expect(surfaces.length).toBeGreaterThanOrEqual(17);
	const ids = surfaces.map((s) => s.id);
	expect(new Set(ids).size).toBe(ids.length);
});

test("listSurfaces preserves registration order (home before chat)", () => {
	const ids = listSurfaces().map((s) => s.id);
	expect(ids.indexOf("home")).toBeLessThan(ids.indexOf("chat"));
	expect(ids.indexOf("chat")).toBeLessThan(ids.indexOf("agents"));
});

// ── registerSurface idempotency ────────────────────────────────────────────────

test("registerSurface ignores a duplicate id (double-import safety)", () => {
	const before = listSurfaces().length;
	const dup: SurfaceModule = {
		id: "chat", // already registered
		title: "Impostor",
		match: () => true,
		Component: () => null,
	};
	registerSurface(dup);
	expect(listSurfaces()).toHaveLength(before);
	// The original chat surface, not the impostor, still owns /chat.
	expect(resolveSurface("/chat")?.title).not.toBe("Impostor");
});

// NOTE: registerSurface's "push a new id" branch is exercised at module load (all
// built-in surfaces register via it) and asserted by the resolve/list tests above.
// We deliberately do NOT register a fresh id here: the registry is a cross-file
// singleton in bun's shared test process, so a leftover surface with no canonical
// path breaks the desktop-shell smoke test that iterates every registered surface.
