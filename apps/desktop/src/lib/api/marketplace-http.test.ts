import { expect, test } from "bun:test";
import {
	authHeaders,
	BASE,
	MarketplaceError,
	type MarketplaceErrorKind,
	toError,
} from "./marketplace-http.ts";

test("targets the control-plane marketplace routes with JSON headers", () => {
	expect(BASE.endsWith("/api/marketplace")).toBe(true);
	expect(authHeaders().get("Content-Type")).toBe("application/json");
});

test("maps degrade-cleanly HTTP statuses onto MarketplaceError kinds", async () => {
	const cases: [Response, MarketplaceErrorKind][] = [
		[Response.json({}, { status: 401 }), "auth"],
		[Response.json({}, { status: 409 }), "no_org"],
		[Response.json({}, { status: 503 }), "stripe"],
		[Response.json({}, { status: 403 }), "seller"],
		[Response.json({ message: "This item is free" }, { status: 400 }), "free"],
		[Response.json({ code: "github_app_missing" }, { status: 400 }), "github"],
	];
	for (const [response, kind] of cases) {
		const error = await toError(response);
		expect(error).toBeInstanceOf(MarketplaceError);
		expect(error.kind).toBe(kind);
	}
});

test("keeps the server code and falls back for non-JSON failures", async () => {
	const coded = await toError(
		Response.json({ code: "limit", error: "Too many" }, { status: 429 })
	);
	expect(coded.kind).toBe("unknown");
	expect(coded.code).toBe("limit");
	expect(coded.message).toBe("Too many");
	const plain = await toError(new Response("oops", { status: 500 }));
	expect(plain.message).toBe("Request failed: 500");
	expect(plain.code).toBeNull();
});
