// Unit tests for the generic Core list reader (core/featureList.ts) — the TS port
// of apps/cli's fetch_feature_list that backs every "fetch a JSON array, show
// title/subtitle/badge/id per row" tab. The load-bearing logic is untyped:
// findArray (container-key resolution + bare-array fallback), pickField (the
// first-non-empty string / number-or-bool coercion / array→length chain), and the
// per-element mapping (string shorthand, non-record fallback, absent optional
// keys). fetch is swapped for a real Response and restored in afterEach so nothing
// hits a node and no swap leaks into the shared-process smoke tests.

import { afterEach, expect, test } from "bun:test";
import type { ApiTarget } from "@ryuhq/core-client/client";
import {
	type FeatureListConfig,
	featureListLoader,
	fetchFeatureList,
} from "../core/featureList.ts";

const target: ApiTarget = { url: "http://node:7980", token: "tok" };
const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

// Serve one JSON payload; capture the URL + headers the reader built.
function serve(payload: unknown, status = 200): { url: () => string; auth: () => string | undefined } {
	let capturedUrl = "";
	let capturedAuth: string | undefined;
	globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
		capturedUrl = String(url);
		capturedAuth = (init?.headers as Record<string, string> | undefined)
			?.Authorization;
		return Promise.resolve(
			new Response(JSON.stringify(payload), { status })
		);
	}) as unknown as typeof fetch;
	return { url: () => capturedUrl, auth: () => capturedAuth };
}

const baseConfig: FeatureListConfig = {
	path: "/api/things",
	titleKeys: ["name", "id"],
	idKeys: ["id"],
};

// ── endpoint + auth plumbing ─────────────────────────────────────────────────

test("builds the node URL from the config path and carries the bearer", async () => {
	const cap = serve([]);
	await fetchFeatureList(target, baseConfig);
	expect(cap.url()).toBe("http://node:7980/api/things");
	expect(cap.auth()).toBe("Bearer tok");
});

test("throws with the status when the response is not ok", async () => {
	serve({ error: "boom" }, 500);
	await expect(fetchFeatureList(target, baseConfig)).rejects.toThrow(
		"/api/things failed: 500"
	);
});

// ── findArray: container-key resolution ──────────────────────────────────────

test("resolves the array from the first matching container key", async () => {
	serve({ other: [1], rows: [{ id: "a", name: "Alpha" }] });
	const rows = await fetchFeatureList(target, {
		...baseConfig,
		containerKeys: ["missing", "rows"],
	});
	expect(rows).toEqual([{ id: "a", title: "Alpha", subtitle: undefined, badge: undefined }]);
});

test("falls back to a bare top-level array when no container key matches", async () => {
	serve([{ id: "x", name: "Ex" }]);
	const rows = await fetchFeatureList(target, {
		...baseConfig,
		containerKeys: ["nope"],
	});
	expect(rows).toHaveLength(1);
	expect(rows[0].id).toBe("x");
});

test("yields an empty list when neither a container key nor a bare array is present", async () => {
	serve({ meta: { total: 0 } });
	const rows = await fetchFeatureList(target, {
		...baseConfig,
		containerKeys: ["items"],
	});
	expect(rows).toEqual([]);
});

// ── pickField coercion chain ─────────────────────────────────────────────────

test("pickField prefers the first non-empty string, in key order", async () => {
	serve([{ id: "id-1", name: "Named" }]);
	const rows = await fetchFeatureList(target, baseConfig);
	// name is non-empty so it wins over id for the title.
	expect(rows[0].title).toBe("Named");
	expect(rows[0].id).toBe("id-1");
});

test("pickField skips an empty string and moves to the next key", async () => {
	serve([{ name: "", id: "fallback" }]);
	const rows = await fetchFeatureList(target, baseConfig);
	// title keys [name, id]: name is "" (skipped) → id.
	expect(rows[0].title).toBe("fallback");
});

test("pickField coerces numbers and booleans to display strings", async () => {
	serve([{ id: "n", count: 7, active: true }]);
	const rows = await fetchFeatureList(target, {
		path: "/api/things",
		titleKeys: ["count"],
		idKeys: ["id"],
		subtitleKeys: ["active"],
	});
	expect(rows[0].title).toBe("7");
	expect(rows[0].subtitle).toBe("true");
});

test("pickField renders an array value as its length", async () => {
	serve([{ id: "t", tags: ["a", "b", "c"] }]);
	const rows = await fetchFeatureList(target, {
		path: "/api/things",
		titleKeys: ["tags"],
		idKeys: ["id"],
	});
	expect(rows[0].title).toBe("3");
});

test("a title with no matching field falls back to the em-dash placeholder", async () => {
	serve([{ id: "only-id" }]);
	const rows = await fetchFeatureList(target, {
		path: "/api/things",
		titleKeys: ["name", "label"],
		idKeys: ["id"],
	});
	expect(rows[0].title).toBe("—");
	expect(rows[0].id).toBe("only-id");
});

// ── per-element mapping shapes ───────────────────────────────────────────────

test("a bare string element becomes {id, title} with the string for both", async () => {
	serve(["plain-value"]);
	const rows = await fetchFeatureList(target, baseConfig);
	expect(rows[0]).toEqual({ id: "plain-value", title: "plain-value" });
});

test("a non-record, non-string element degrades to the em-dash row", async () => {
	serve([42, null, true]);
	const rows = await fetchFeatureList(target, baseConfig);
	// null is an object but not a record → falls to the {id:"", title:"—"} branch;
	// numbers/booleans likewise.
	expect(rows).toEqual([
		{ id: "", title: "—" },
		{ id: "", title: "—" },
		{ id: "", title: "—" },
	]);
});

test("optional subtitle/badge stay undefined when their keys are unset or empty", async () => {
	serve([{ id: "r", name: "Row", note: "" }]);
	const rows = await fetchFeatureList(target, {
		path: "/api/things",
		titleKeys: ["name"],
		idKeys: ["id"],
		subtitleKeys: ["note"], // present but "" → empty → undefined
		// badgeKeys omitted entirely → undefined
	});
	expect(rows[0].subtitle).toBeUndefined();
	expect(rows[0].badge).toBeUndefined();
});

test("subtitle and badge are surfaced when their keys resolve", async () => {
	serve([{ id: "r", name: "Row", desc: "a row", version: "1.2.3" }]);
	const rows = await fetchFeatureList(target, {
		path: "/api/things",
		titleKeys: ["name"],
		idKeys: ["id"],
		subtitleKeys: ["desc"],
		badgeKeys: ["version"],
	});
	expect(rows[0].subtitle).toBe("a row");
	expect(rows[0].badge).toBe("1.2.3");
});

// ── featureListLoader wrapper ────────────────────────────────────────────────

test("featureListLoader binds a config into a (target, signal) loader", async () => {
	serve([{ id: "z", name: "Zed" }]);
	const load = featureListLoader(baseConfig);
	const rows = await load(target);
	expect(rows[0]).toEqual({
		id: "z",
		title: "Zed",
		subtitle: undefined,
		badge: undefined,
	});
});
