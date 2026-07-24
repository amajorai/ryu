// Unit tests for the pure gateway-status narrowing helpers
// (overlays/gateway/status.ts). These mirror the Rust client's chain of
// `.get(...).and_then(...)` reads over the untyped `effective_config` / `metrics`
// blobs Core passes through verbatim, so the fallback chains (routingDefault,
// dlpEnabled dlp-vs-pii, requestsTotal flat-vs-nested) and the type guards
// (asBool/asString/asNumber/asStringArray) are the load-bearing logic. The hook
// useGatewayStatus is exercised separately by the overlay smoke tests; here we pin
// the pure getters that a regression would silently break.

import { expect, test } from "bun:test";
import {
	apiKeyNames,
	asBool,
	asNumber,
	asString,
	asStringArray,
	dlpEnabled,
	errText,
	getPath,
	modelMapEntries,
	requestsTotal,
	routingDefault,
} from "../overlays/gateway/status.ts";

// ── getPath ─────────────────────────────────────────────────────────────────────

test("getPath walks nested object keys to the leaf value", () => {
	expect(getPath({ a: { b: { c: 42 } } }, "a", "b", "c")).toBe(42);
});

test("getPath returns undefined when a hop is missing or not an object", () => {
	expect(getPath({ a: { b: 1 } }, "a", "b", "c")).toBeUndefined();
	expect(getPath({ a: 5 }, "a", "b")).toBeUndefined();
	expect(getPath(null, "a")).toBeUndefined();
	// Arrays are not treated as records.
	expect(getPath({ a: [1, 2] }, "a", "0")).toBeUndefined();
});

test("getPath with no keys returns the root unchanged", () => {
	const root = { a: 1 };
	expect(getPath(root)).toBe(root);
});

// ── scalar guards ─────────────────────────────────────────────────────────────

test("asBool only treats an exact true as true", () => {
	expect(asBool(true)).toBe(true);
	expect(asBool(false)).toBe(false);
	expect(asBool(1)).toBe(false);
	expect(asBool("true")).toBe(false);
	expect(asBool(undefined)).toBe(false);
});

test("asString returns strings and null otherwise", () => {
	expect(asString("hi")).toBe("hi");
	expect(asString("")).toBe("");
	expect(asString(3)).toBeNull();
	expect(asString(null)).toBeNull();
});

test("asNumber accepts only finite numbers", () => {
	expect(asNumber(0)).toBe(0);
	expect(asNumber(-2.5)).toBe(-2.5);
	expect(asNumber(Number.NaN)).toBeNull();
	expect(asNumber(Number.POSITIVE_INFINITY)).toBeNull();
	expect(asNumber("5")).toBeNull();
});

test("asStringArray filters to string members and rejects non-arrays", () => {
	expect(asStringArray(["a", 1, "b", null, "c"])).toEqual(["a", "b", "c"]);
	expect(asStringArray([])).toEqual([]);
	expect(asStringArray("nope")).toEqual([]);
	expect(asStringArray(undefined)).toEqual([]);
});

// ── routingDefault fallback chain ───────────────────────────────────────────────

test("routingDefault prefers default_model, then default_provider, then default", () => {
	expect(
		routingDefault({
			routing: { default_model: "m", default_provider: "p", default: "d" },
		})
	).toBe("m");
	expect(
		routingDefault({ routing: { default_provider: "p", default: "d" } })
	).toBe("p");
	expect(routingDefault({ routing: { default: "d" } })).toBe("d");
});

test("routingDefault falls back to the em-dash placeholder when unset", () => {
	expect(routingDefault({})).toBe("—");
	expect(routingDefault({ routing: {} })).toBe("—");
	expect(routingDefault(null)).toBe("—");
});

// ── dlpEnabled dlp-vs-pii fallback ───────────────────────────────────────────────

test("dlpEnabled reads dlp.enabled when the dlp key is present", () => {
	expect(dlpEnabled({ dlp: { enabled: true }, pii: { enabled: false } })).toBe(
		true
	);
	// dlp present but disabled: does NOT fall through to pii.
	expect(dlpEnabled({ dlp: { enabled: false }, pii: { enabled: true } })).toBe(
		false
	);
});

test("dlpEnabled falls back to pii.enabled only when dlp is absent", () => {
	expect(dlpEnabled({ pii: { enabled: true } })).toBe(true);
	expect(dlpEnabled({})).toBe(false);
});

// ── requestsTotal flat-vs-nested fallback ────────────────────────────────────────

test("requestsTotal prefers requests_total, then total_requests, then requests.total", () => {
	expect(requestsTotal({ requests_total: 10, total_requests: 20 })).toBe(10);
	expect(requestsTotal({ total_requests: 20, requests: { total: 30 } })).toBe(
		20
	);
	expect(requestsTotal({ requests: { total: 30 } })).toBe(30);
});

test("requestsTotal returns null when no known key holds a number", () => {
	expect(requestsTotal({})).toBeNull();
	expect(requestsTotal({ requests_total: "10" })).toBeNull();
});

// ── modelMapEntries ─────────────────────────────────────────────────────────────

test("modelMapEntries maps routing.model_map to {model, provider} rows", () => {
	const entries = modelMapEntries({
		routing: {
			model_map: {
				"gpt-4": { provider: "openai" },
				sonnet: { provider: "anthropic" },
			},
		},
	});
	expect(entries).toContainEqual({ model: "gpt-4", provider: "openai" });
	expect(entries).toContainEqual({ model: "sonnet", provider: "anthropic" });
	expect(entries).toHaveLength(2);
});

test("modelMapEntries defaults a missing provider to the em-dash", () => {
	const entries = modelMapEntries({
		routing: { model_map: { foo: {} } },
	});
	expect(entries).toEqual([{ model: "foo", provider: "—" }]);
});

test("modelMapEntries returns an empty list when the map is absent", () => {
	expect(modelMapEntries({})).toEqual([]);
	expect(modelMapEntries({ routing: {} })).toEqual([]);
});

// ── apiKeyNames ─────────────────────────────────────────────────────────────────

test("apiKeyNames surfaces only the name of each auth key", () => {
	const names = apiKeyNames({
		auth: {
			api_keys: [{ name: "prod", value: "sk-secret" }, { name: "dev" }, {}],
		},
	});
	// Redacted values never appear; the nameless entry is skipped.
	expect(names).toEqual(["prod", "dev"]);
});

test("apiKeyNames returns an empty list when api_keys is absent or not an array", () => {
	expect(apiKeyNames({})).toEqual([]);
	expect(apiKeyNames({ auth: { api_keys: "nope" } })).toEqual([]);
});

// ── errText ─────────────────────────────────────────────────────────────────────

test("errText reads an Error's message and stringifies non-Errors", () => {
	expect(errText(new Error("boom"))).toBe("boom");
	expect(errText("plain")).toBe("plain");
	expect(errText(404)).toBe("404");
});
