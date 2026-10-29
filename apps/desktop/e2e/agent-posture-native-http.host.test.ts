import { expect, test } from "bun:test";
import {
	POSTURE_PATH,
	startAgentPostureProofHost,
} from "./agent-posture-native-http.host.ts";

const headers = {
	authorization: "Bearer version-bearer-a",
	"x-ryu-user-jwt": "version-user-a",
	"content-type": "application/json",
};
test("the actual HTTP posture fixture refuses foreign authority, invalid sparse DTO and unknown mutations without publishing them", async () => {
	const host = startAgentPostureProofHost(0);
	const base = `http://127.0.0.1:${host.server.port}`;
	try {
		const before = await (
			await fetch(`${base}/scope-a${POSTURE_PATH}`, { headers })
		).json();
		const wrong = await fetch(`${base}/scope-a${POSTURE_PATH}`, {
			method: "PUT",
			headers: { ...headers, "x-ryu-user-jwt": "wrong" },
			body: JSON.stringify({ safety_profile: "autonomous" }),
		});
		expect(wrong.status).toBe(403);
		const invalid = await fetch(`${base}/scope-a${POSTURE_PATH}`, {
			method: "PUT",
			headers,
			body: JSON.stringify({
				safety_profile: "autonomous",
				name: "hidden unwanted write",
			}),
		});
		expect(invalid.status).toBe(400);
		for (const invalidScalar of [
			{ lifecycle_status: ["active"] },
			{ safety_profile: ["autonomous"] },
		]) {
			const refused = await fetch(`${base}/scope-a${POSTURE_PATH}`, {
				method: "PUT",
				headers,
				body: JSON.stringify(invalidScalar),
			});
			expect(refused.status).toBe(400);
		}
		const unknown = await fetch(`${base}/scope-a${POSTURE_PATH}/posture`, {
			method: "POST",
			headers,
			body: "{}",
		});
		expect(unknown.status).toBe(503);
		expect(
			await (await fetch(`${base}/scope-a${POSTURE_PATH}`, { headers })).json()
		).toEqual(before);
		const state = await (await fetch(`${base}/__state`)).json();
		expect(state.unexpected).toHaveLength(5);
	} finally {
		host.close();
	}
});
test("real held posture HTTP request cannot publish before acknowledgement, and genuine403 leaves independent GET unchanged", async () => {
	const host = startAgentPostureProofHost(0);
	const base = `http://127.0.0.1:${host.server.port}`;
	try {
		const before = await (
			await fetch(`${base}/scope-a${POSTURE_PATH}`, { headers })
		).json();
		const control = await fetch(`${base}/__control`, {
			method: "POST",
			headers: {
				"x-proof-control": "owned-posture-proof",
				"content-type": "application/json",
			},
			body: JSON.stringify({ action: "next", hold: true, status: 403 }),
		});
		expect(control.status).toBe(200);
		const pending = fetch(`${base}/scope-a${POSTURE_PATH}`, {
			method: "PUT",
			headers,
			body: JSON.stringify({ safety_profile: "autonomous" }),
		});
		let held: number[] = [];
		for (let i = 0; i < 50 && !held.length; i++) {
			held = (await (await fetch(`${base}/__state`)).json()).held;
			await new Promise((resolve) => setImmediate(resolve));
		}
		expect(held).toHaveLength(1);
		expect(
			await (await fetch(`${base}/scope-a${POSTURE_PATH}`, { headers })).json()
		).toEqual(before);
		const release = await fetch(`${base}/__control`, {
			method: "POST",
			headers: {
				"x-proof-control": "owned-posture-proof",
				"content-type": "application/json",
			},
			body: JSON.stringify({ action: "release", id: held[0] }),
		});
		expect(release.status).toBe(200);
		expect((await pending).status).toBe(403);
		expect(
			await (await fetch(`${base}/scope-a${POSTURE_PATH}`, { headers })).json()
		).toEqual(before);
		expect((await (await fetch(`${base}/__state`)).json()).unexpected).toEqual(
			[]
		);
	} finally {
		host.close();
	}
});

test("editor prerequisites admit only source-backed GET queries and retain the exact rejected URL", async () => {
	const host = startAgentPostureProofHost(0);
	const base = `http://127.0.0.1:${host.server.port}/scope-a`;
	try {
		for (const path of [
			"/api/agents/catalog",
			"/api/models/installed",
			"/api/models/active",
			"/api/pi-config",
			"/api/pi-config/catalog",
			`${POSTURE_PATH}/capabilities?model=current-model`,
			"/api/routing/advice?agent_id=version-proof&model=current-model&at_conversation_start=false",
		]) {
			const response = await fetch(`${base}${path}`, { headers });
			expect(response.status).toBe(200);
			await response.json();
		}
		const badUrl = `${base}${POSTURE_PATH}/capabilities?model=foreign-model`;
		expect((await fetch(badUrl, { headers })).status).toBe(503);
		expect(
			(await fetch(`${base}/api/pi-config/catalog?ignored=true`, { headers }))
				.status
		).toBe(503);
		expect(
			(
				await fetch(`${base}/api/models/active`, {
					method: "PUT",
					headers,
					body: "{}",
				})
			).status
		).toBe(503);
		expect(
			(
				await fetch(`${base}/api/pi-config`, {
					headers: { ...headers, "x-ryu-user-jwt": "foreign" },
				})
			).status
		).toBe(403);
		const state = await (
			await fetch(`http://127.0.0.1:${host.server.port}/__state`)
		).json();
		expect(state.unexpected).toHaveLength(4);
		expect(state.unexpected[0]).toMatchObject({
			url: badUrl,
			query: "?model=foreign-model",
			status: 503,
		});
	} finally {
		host.close();
	}
});
