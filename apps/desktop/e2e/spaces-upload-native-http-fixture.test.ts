import { expect, test } from "bun:test";
import { startSpacesUploadHost } from "./spaces-upload-native-http.host.ts";
test("finite upload host refuses bytes without exact authority/schema and persists only accepted retry bytes for independent GET", async () => {
	const owned = startSpacesUploadHost(0, "http://owned-fixture.invalid");
	const url = `http://127.0.0.1:${owned.server.port}`;
	const headers = {
		authorization: "Bearer spaces-upload-owned-token",
		"content-type": "application/json",
	};
	try {
		const wrong = await fetch(`${url}/api/spaces/space-owned/files`, {
			method: "POST",
			headers: { ...headers, "x-ryu-user-jwt": "foreign-account" },
			body: JSON.stringify({
				title: "a.txt",
				mime: "text/plain",
				data_base64: "YWJj",
			}),
		});
		expect(wrong.status).toBe(403);
		const malformed = await fetch(`${url}/api/spaces/space-owned/files`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				title: "a.txt",
				mime: "text/plain",
				data_base64: "not-base64",
				extra: true,
			}),
		});
		expect(malformed.status).toBe(503);
		await fetch(`${url}/__control`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-proof-control": "owned-fixture",
			},
			body: JSON.stringify({ action: "refuse", title: "a.txt" }),
		});
		const body = JSON.stringify({
			title: "a.txt",
			mime: "text/plain",
			data_base64: "YWJj",
		});
		expect(
			(
				await fetch(`${url}/api/spaces/space-owned/files`, {
					method: "POST",
					headers,
					body,
				})
			).status
		).toBe(503);
		expect((await (await fetch(`${url}/__state`)).json()).documents).toEqual(
			[]
		);
		await fetch(`${url}/__control`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-proof-control": "owned-fixture",
			},
			body: JSON.stringify({ action: "allow" }),
		});
		expect(
			(
				await fetch(`${url}/api/spaces/space-owned/files`, {
					method: "POST",
					headers,
					body,
				})
			).status
		).toBe(200);
		const state = await (await fetch(`${url}/__state`)).json();
		expect(
			state.documents.map(
				(document: { title: string; data_base64: string }) => ({
					title: document.title,
					data: document.data_base64,
				})
			)
		).toEqual([{ title: "a.txt", data: "YWJj" }]);
		const read = await fetch(`${url}/api/spaces/space-owned/documents`, {
			headers,
		});
		expect(read.status).toBe(200);
		expect((await read.json()).documents[0]).toMatchObject({
			title: "a.txt",
			byte_size: 3,
			mime: "text/plain",
			space_id: "space-owned",
			index: { state: "indexed" },
		});
	} finally {
		owned.release();
		owned.server.stop(true);
	}
});
test("held physical upload cannot create persisted row until acknowledgement and release preserves exact binary bytes", async () => {
	const owned = startSpacesUploadHost(0, "http://owned-fixture.invalid"),
		url = `http://127.0.0.1:${owned.server.port}`;
	const headers = {
		authorization: "Bearer spaces-upload-owned-token",
		"content-type": "application/json",
	};
	try {
		await fetch(`${url}/__control`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-proof-control": "owned-fixture",
			},
			body: JSON.stringify({ action: "hold" }),
		});
		const pending = fetch(`${url}/api/spaces/space-owned/files`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				title: "b.bin",
				mime: "application/octet-stream",
				data_base64: "AP8qgA==",
			}),
		});
		let state = await (await fetch(`${url}/__state`)).json();
		for (let attempt = 0; state.calls.length === 0 && attempt < 30; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 2));
			state = await (await fetch(`${url}/__state`)).json();
		}
		expect(state.calls).toHaveLength(1);
		expect(state.calls[0].status).toBeNull();
		expect(state.documents).toEqual([]);
		owned.release();
		expect((await pending).status).toBe(200);
		state = await (await fetch(`${url}/__state`)).json();
		expect(state.documents[0]).toMatchObject({
			data_base64: "AP8qgA==",
			byte_size: 4,
			index: { state: "skipped" },
		});
		expect(state.unexpected).toEqual([]);
	} finally {
		owned.release();
		owned.server.stop(true);
	}
});
test("exact SDK attribution/auth CORS preflight permits a subsequent authenticated real Spaces GET and refuses unknown route preflight", async () => {
	const origin = "http://owned-fixture.invalid",
		owned = startSpacesUploadHost(0, origin),
		url = `http://127.0.0.1:${owned.server.port}`;
	try {
		const preflight = await fetch(`${url}/api/spaces`, {
			method: "OPTIONS",
			headers: {
				origin,
				"access-control-request-method": "GET",
				"access-control-request-headers":
					"authorization,x-ryu-client-id,x-ryu-client-label,x-ryu-surface",
			},
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
		const allowed =
			preflight.headers.get("access-control-allow-headers")?.split(",") ?? [];
		for (const header of [
			"authorization",
			"x-ryu-client-id",
			"x-ryu-client-label",
			"x-ryu-surface",
		])
			expect(allowed).toContain(header);
		expect(allowed).not.toContain("*");
		const response = await fetch(`${url}/api/spaces`, {
			headers: {
				origin,
				authorization: "Bearer spaces-upload-owned-token",
				"x-ryu-client-id": "owned-installed-client",
				"x-ryu-client-label": "Desktop",
				"x-ryu-surface": "desktop",
			},
		});
		expect(response.status).toBe(200);
		expect((await response.json()).spaces[0].id).toBe("space-owned");
		const state = await (await fetch(`${url}/__state`)).json();
		expect(state.calls[0]).toMatchObject({
			method: "GET",
			path: "/api/spaces",
			clientId: "owned-installed-client",
			clientLabel: "Desktop",
			surface: "desktop",
			status: 200,
		});
		expect(state.unexpected).toEqual([]);
		const unknown = await fetch(`${url}/api/unimplemented`, {
			method: "OPTIONS",
			headers: { origin },
		});
		expect(unknown.status).not.toBe(204);
	} finally {
		owned.release();
		owned.server.stop(true);
	}
});
