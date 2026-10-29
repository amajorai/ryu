import { afterEach, expect, test } from "bun:test";
import { startNotificationProofHost } from "./system-notifications-story.host.ts";
let fixture: ReturnType<typeof startNotificationProofHost> | undefined;
afterEach(() => {
	fixture?.stop();
	fixture = undefined;
});
const auth = {
	authorization: "Bearer notification-node-a",
	"x-ryu-user-jwt": "notification-user-a",
	accept: "text/event-stream",
};
function start() {
	fixture = startNotificationProofHost(0);
	return fixture;
}
async function until(check: () => boolean) {
	const end = Date.now() + 2000;
	while (!check()) {
		if (Date.now() > end)
			throw Error("Native fixture lifecycle did not settle");
		await Bun.sleep(10);
	}
}
async function control(
	host: ReturnType<typeof startNotificationProofHost>,
	body: Record<string, unknown>,
) {
	return fetch(new URL("/__proof/control", host.server.url), {
		method: "POST",
		headers: {
			"x-notification-proof-control": "owned-local-fixture",
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
}
test("finite authenticated host sends actual notification frames and records real fetch abort", async () => {
	const host = start(),
		abort = new AbortController();
	const response = await fetch(new URL("/api/events/all", host.server.url), {
		headers: auth,
		signal: abort.signal,
	});
	expect(response.status).toBe(200);
	const reader = response.body?.getReader();
	if (!reader) throw Error("No real stream");
	const first = await reader.read();
	expect(new TextDecoder().decode(first.value)).toContain(": connected");
	expect(host.state.requests[0]).toMatchObject({
		method: "GET",
		path: "/api/events/all",
		token: auth.authorization,
		userJwt: auth["x-ryu-user-jwt"],
		status: 200,
		closed: false,
	});
	const payload = {
		title: "Real fixture notification",
		body: "Authored exact payload.",
		level: "warning",
	};
	expect(
		(
			await control(host, {
				action: "emit",
				requestId: host.state.requests[0]?.id,
				notification: payload,
			})
		).status,
	).toBe(200);
	let frames = "";
	while (!frames.includes("event: notifications")) {
		const next = await reader.read();
		frames += new TextDecoder().decode(next.value);
	}
	expect(frames).toContain(
		`event: notifications\ndata: ${JSON.stringify(payload)}\n\n`,
	);
	expect(host.state.requests[0]?.sent).toEqual([payload]);
	abort.abort();
	await reader.cancel().catch(() => {});
	await until(() => host.state.requests[0]?.closed === true);
	expect(host.state.unexpected).toEqual([]);
	expect(
		(
			await control(host, {
				action: "emit",
				requestId: host.state.requests[0]?.id,
				notification: payload,
			})
		).status,
	).toBe(409);
	expect(host.state.requests[0]?.sent).toEqual([payload]);
});
test("an actual503 is distinct from a later authenticated successful SSE connection", async () => {
	const host = start();
	expect((await control(host, { action: "reset", refused: 1 })).status).toBe(
		200,
	);
	const response = await fetch(new URL("/api/events/all", host.server.url), {
		headers: auth,
	});
	expect(response.status).toBe(503);
	expect(await response.text()).toBe("Temporarily unavailable");
	const abort = new AbortController(),
		stream = await fetch(new URL("/api/events/all", host.server.url), {
			headers: auth,
			signal: abort.signal,
		});
	expect(stream.status).toBe(200);
	expect(host.state.requests.map((r) => r.status)).toEqual([503, 200]);
	abort.abort();
	expect(host.state.unexpected).toEqual([]);
});
test("unsupported verbs, unknown credentials and forged controls persist refusals instead of success fallbacks", async () => {
	const host = start();
	const unknown = await fetch(new URL("/api/events/all", host.server.url), {
		method: "POST",
		headers: auth,
	});
	expect(unknown.status).toBe(503);
	const unauthorized = await fetch(
		new URL("/api/events/all", host.server.url),
		{ headers: { ...auth, authorization: "Bearer unknown" } },
	);
	expect(unauthorized.status).toBe(401);
	const forged = await fetch(new URL("/__proof/control", host.server.url), {
		method: "POST",
		body: JSON.stringify({ action: "reset", refused: 0 }),
	});
	expect(forged.status).toBe(401);
	expect(host.state.requests).toEqual([]);
	expect(host.state.unexpected.map((r) => r.reason)).toEqual([
		"Unsupported method/path/stream contract",
		"Unknown credential pair",
		"Unowned fixture control",
	]);
});
test("actual browser preflight permits only the known GET stream and owned origin", async () => {
	const host = start();
	const url = new URL("/api/events/all", host.server.url);
	const good = await fetch(url, {
		method: "OPTIONS",
		headers: {
			origin: "http://127.0.0.1:5660",
			"access-control-request-method": "GET",
		},
	});
	expect(good.status).toBe(204);
	expect(good.headers.get("access-control-allow-headers")).toContain(
		"x-ryu-user-jwt",
	);
	const bad = await fetch(url, {
		method: "OPTIONS",
		headers: {
			origin: "https://foreign.invalid",
			"access-control-request-method": "GET",
		},
	});
	expect(bad.status).toBe(503);
	expect(host.state.unexpected).toHaveLength(1);
});

test("native live socket diagnostics match the actual retained request and disappear on fetch abort", async () => {
	const host = start(),
		abort = new AbortController();
	const response = await fetch(new URL("/api/events/all", host.server.url), {
		headers: auth,
		signal: abort.signal,
	});
	const reader = response.body!.getReader();
	await reader.read();
	const stateUrl = new URL("/__proof/state", host.server.url);
	const live = await (await fetch(stateUrl)).json();
	expect(live.requests).toHaveLength(1);
	expect(live.requests[0].closed).toBe(false);
	expect(live.requests[0].lifecycle.observedPeer).toEqual(
		live.requests[0].lifecycle.peer,
	);
	expect(live.requests[0].lifecycle.observedPeer.address).toBe("127.0.0.1");
	expect(live.pendingServerRequests).toBe(2);
	abort.abort();
	await reader.cancel().catch(() => {});
	await until(() => host.state.requests[0]?.closed === true);
	const closed = await (await fetch(stateUrl)).json();
	expect(closed.requests[0].closed).toBe(true);
	expect(closed.requests[0].lifecycle.observedPeer).toBeNull();
	expect(closed.pendingServerRequests).toBe(1);
	expect(closed.unexpected).toEqual([]);
});

test("Linux kernel TCP observation independently identifies the owned established stream and its physical abort", async () => {
	const host = start(),
		abort = new AbortController();
	const response = await fetch(new URL("/api/events/all", host.server.url), {
		headers: auth,
		signal: abort.signal,
	});
	const reader = response.body!.getReader();
	await reader.read();
	const stateUrl = new URL("/__proof/state", host.server.url);
	const current = await (await fetch(stateUrl)).json();
	expect(current.requests[0].lifecycle.localPort).toBe(host.server.port);
	expect(current.requests[0].lifecycle.requestHeaders.authorization).toBe(
		auth.authorization,
	);
	expect(current.requests[0].lifecycle.requestHeaders["x-ryu-user-jwt"]).toBe(
		auth["x-ryu-user-jwt"],
	);
	if (process.platform === "linux")
		expect(current.requests[0].lifecycle.kernelTcp).toEqual({
			supported: true,
			states: ["01"],
		});
	else expect(current.requests[0].lifecycle.kernelTcp.supported).toBe(false);
	abort.abort();
	await reader.cancel().catch(() => {});
	await until(() => host.state.requests[0]?.closed === true);
	const closed = await (await fetch(stateUrl)).json();
	if (process.platform === "linux") {
		expect(closed.requests[0].lifecycle.kernelTcp.supported).toBe(true);
		expect(closed.requests[0].lifecycle.kernelTcp.states.includes("01")).toBe(
			false,
		);
	} else expect(closed.requests[0].lifecycle.kernelTcp.supported).toBe(false);
	expect(closed.unexpected).toEqual([]);
});
