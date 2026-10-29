import { expect, test } from "bun:test";
import { parseCloudEnvironmentState } from "@ryuhq/protocol/cloud-environments";
import { createScrollableTabsCoreFixture } from "./harness/scrollable-tabs-core-fixture.ts";

test("tab host cloud fixture passes the production wire decoder", () => {
	const response = createScrollableTabsCoreFixture()(
		"GET",
		"/api/cloud-environments"
	);
	if (!response || !("json" in response))
		throw new Error("Missing cloud snapshot");
	expect(parseCloudEnvironmentState(response.json)).toEqual({
		schemaVersion: 1,
		revision: 0,
		environments: [],
		vault: [],
	});
});

test("presence heartbeat preserves reported status and rejects malformed writes", () => {
	const fixture = createScrollableTabsCoreFixture();
	for (const status of [
		"online",
		"away",
		"do-not-disturb",
		"gaming",
		"streaming",
	]) {
		const response = fixture("PUT", "/api/presence", {
			clientId: "window-fixture",
			status,
		});
		if (!response || !("json" in response))
			throw new Error("Missing presence snapshot");
		expect(response.json).toMatchObject({
			status,
			source: "reported",
			questionsDeferred: status !== "online",
			gaming: { active: false, detectedGame: null },
			streaming: { active: false, detectedApp: null },
		});
	}
	for (const body of [
		undefined,
		{},
		{ status: "online" },
		{ clientId: "", status: "online" },
		{ clientId: "fixture", status: "unknown" },
		{ clientId: "fixture", status: "online", ignored: true },
	]) {
		expect(fixture("PUT", "/api/presence", body)?.status).toBe(400);
	}
});

test("new tab host fixtures preserve the strict unknown method and route gate", () => {
	const fixture = createScrollableTabsCoreFixture();
	for (const [method, route] of [
		["GET", "/api/presence"],
		["POST", "/api/presence"],
		["PUT", "/api/cloud-environments"],
		["GET", "/api/cloud-environments/unknown"],
		["DELETE", "/api/cloud-environments"],
		["GET", "/api/unknown"],
	]) {
		expect(fixture(method, route)).toBeUndefined();
	}
});
