// packages/core-client/src/recipes.test.ts
//
// Tests for the ghost-recipes client. The load-bearing pure logic is
// `draftRecipeFromEvents` — the OFFLINE FALLBACK that scaffolds an editable
// recipe from a captured AX action sequence when an older Core omits the draft.
// Each event kind maps to a distinct step shape (type/press/hotkey/scroll/
// app_switch/default-click), the task is slugified into a safe name, and the app
// is inferred from the first event that names one. The request-unwrapping helpers
// (list/get/save/run) are covered against a stubbed fetch to pin the envelope
// shapes (`{ recipes }`, `{ recipe }`, `{ name }`, `{ result }`).

import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	draftRecipeFromEvents,
	getRecipe,
	type LearnedEvent,
	listRecipes,
	runRecipe,
	saveRecipe,
} from "./recipes.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const target: ApiTarget = { url: "http://127.0.0.1:7980", token: "t" };

interface Captured {
	init?: RequestInit;
	url?: string;
}

/** Stub fetch to return `bodyText` and capture the outgoing url + init. */
function stubFetch(bodyText: string, status = 200): Captured {
	const cap: Captured = {};
	globalThis.fetch = ((url: string, init: RequestInit) => {
		cap.url = url;
		cap.init = init;
		return Promise.resolve(new Response(bodyText, { status }));
	}) as typeof fetch;
	return cap;
}

const ev = (over: Partial<LearnedEvent>): LearnedEvent => ({
	event_type: "click",
	ts_ms: 0,
	...over,
});

describe("draftRecipeFromEvents — envelope", () => {
	test("slugifies the task and defaults the empty envelope", () => {
		const r = draftRecipeFromEvents("Open Mail App!", []);
		expect(r.name).toBe("open-mail-app");
		expect(r.description).toBe("Open Mail App!");
		expect(r.schema_version).toBe(2);
		expect(r.on_failure).toBe("abort");
		expect(r.params).toEqual({});
		expect(r.app).toBeNull();
		expect(r.steps).toEqual([]);
	});

	test("falls back to a placeholder name+description for an empty task", () => {
		const r = draftRecipeFromEvents("   ", []);
		// Leading/trailing dashes are trimmed; an all-symbol task collapses to "".
		expect(r.name).toBe("recorded-recipe");
		const r2 = draftRecipeFromEvents("", []);
		expect(r2.name).toBe("recorded-recipe");
		expect(r2.description).toBe("Recorded workflow");
	});

	test("infers the app from the first event that names one", () => {
		const r = draftRecipeFromEvents("x", [
			ev({ app_name: null }),
			ev({ app_name: "Safari" }),
			ev({ app_name: "Mail" }),
		]);
		expect(r.app).toBe("Safari");
	});
});

describe("draftRecipeFromEvents — per-event step mapping", () => {
	test("default (click) builds an AX locator target and a note", () => {
		const [step] = draftRecipeFromEvents("t", [
			ev({
				event_type: "click",
				element_name: "Send",
				element_role: "button",
				element_id: "btn1",
				app_name: "Mail",
			}),
		]).steps;
		expect(step).toEqual({
			id: 1,
			action: "click",
			target: {
				query: "Send",
				role: "button",
				identifier: "btn1",
				app: "Mail",
			},
			note: "Send",
		});
	});

	test("a click with no AX context yields a null target", () => {
		const [step] = draftRecipeFromEvents("t", [
			ev({ event_type: "click" }),
		]).steps;
		expect(step.target).toBeNull();
		expect(step.action).toBe("click");
	});

	test("type carries the typed text and keeps the locator", () => {
		const [step] = draftRecipeFromEvents("t", [
			ev({ event_type: "type", key: "hello", element_name: "Field" }),
		]).steps;
		expect(step).toEqual({
			id: 1,
			action: "type",
			target: { query: "Field", role: null, identifier: null, app: null },
			params: { text: "hello" },
		});
	});

	test("type with a missing key defaults the text to empty", () => {
		const [step] = draftRecipeFromEvents("t", [
			ev({ event_type: "type", key: null }),
		]).steps;
		expect(step.params).toEqual({ text: "" });
	});

	test("press / hotkey carry the key and omit any target", () => {
		const [press, hotkey] = draftRecipeFromEvents("t", [
			ev({ event_type: "press", key: "Enter" }),
			ev({ event_type: "hotkey", key: "cmd+s" }),
		]).steps;
		expect(press).toEqual({ id: 1, action: "press", params: { key: "Enter" } });
		expect(hotkey).toEqual({
			id: 2,
			action: "hotkey",
			params: { keys: "cmd+s" },
		});
	});

	test("scroll defaults the direction to down when no key is present", () => {
		const [withDir, without] = draftRecipeFromEvents("t", [
			ev({ event_type: "scroll", key: "up" }),
			ev({ event_type: "scroll", key: null }),
		]).steps;
		expect(withDir.params).toEqual({ direction: "up" });
		expect(without.params).toEqual({ direction: "down" });
	});

	test("app_switch becomes a focus step naming the app", () => {
		const [step] = draftRecipeFromEvents("t", [
			ev({ event_type: "app_switch", app_name: "Notes" }),
		]).steps;
		expect(step).toEqual({ id: 1, action: "focus", params: { app: "Notes" } });
	});

	test("assigns sequential 1-based step ids", () => {
		const steps = draftRecipeFromEvents("t", [
			ev({ event_type: "press", key: "a" }),
			ev({ event_type: "press", key: "b" }),
			ev({ event_type: "press", key: "c" }),
		]).steps;
		expect(steps.map((s) => s.id)).toEqual([1, 2, 3]);
	});
});

describe("recipes request unwrapping", () => {
	test("listRecipes returns the array and defaults to [] when absent", async () => {
		stubFetch(JSON.stringify({ recipes: [{ name: "a" }] }));
		expect(await listRecipes(target)).toEqual([{ name: "a" }]);
		stubFetch("{}");
		expect(await listRecipes(target)).toEqual([]);
	});

	test("getRecipe URL-encodes the name and unwraps `recipe`", async () => {
		const cap = stubFetch(JSON.stringify({ recipe: { name: "a/b" } }));
		const r = await getRecipe(target, "a/b");
		expect(r).toEqual({ name: "a/b" });
		expect(cap.url).toBe("http://127.0.0.1:7980/api/recipes/a%2Fb");
	});

	test("saveRecipe POSTs `{ recipe }` and returns the assigned name", async () => {
		const cap = stubFetch(JSON.stringify({ name: "saved" }));
		const name = await saveRecipe(target, {
			schema_version: 2,
			name: "x",
			description: "d",
			steps: [],
		});
		expect(name).toBe("saved");
		expect(cap.init?.method).toBe("POST");
		expect(JSON.parse(cap.init?.body as string)).toEqual({
			recipe: { schema_version: 2, name: "x", description: "d", steps: [] },
		});
	});

	test("runRecipe POSTs the params and unwraps `result`", async () => {
		const cap = stubFetch(
			JSON.stringify({ result: { recipe_name: "x", success: true } })
		);
		const res = await runRecipe(target, "my recipe", { q: "1" });
		expect(res).toEqual({ recipe_name: "x", success: true });
		expect(cap.url).toBe("http://127.0.0.1:7980/api/recipes/my%20recipe/run");
		expect(JSON.parse(cap.init?.body as string)).toEqual({
			params: { q: "1" },
		});
	});
});
