import { afterEach, expect, test } from "bun:test";
import { parseCloudTaskStatus } from "./cloud-tasks.ts";
import {
	connectSessionBoxScreen,
	parseDesktopGrant,
	parseSessionBoxStatus,
	parseSessionBoxView,
	sessionBoxErrorMessage,
	sessionBoxKey,
	sessionBoxRelayUrl,
} from "./session-box.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

const FULL_VIEW = {
	id: "box-1",
	size: "large",
	state: "ready",
	source: "cloud_task",
	child: null,
	placement: {
		provider: "hetzner",
		location: "fsn1",
		tier: "pool",
		isolation: "vm",
	},
	desktop: { ready: true, viewers: 2 },
	runningSince: "2026-10-19T10:00:00Z",
	runningSeconds: 600,
	accruedMicroUsd: 11_667,
	ratePerHourMicroUsd: 70_000,
	balanceMicroUsd: -5,
	minutesRemaining: 0,
	warning: "critical",
	stopReason: "balance",
	expiresAt: "2026-10-19T14:00:00Z",
};

test("parses a full session Box view", () => {
	expect(parseSessionBoxView(FULL_VIEW)).toEqual({
		id: "box-1",
		size: "large",
		state: "ready",
		source: "cloud_task",
		child: null,
		placement: {
			provider: "hetzner",
			location: "fsn1",
			tier: "pool",
			isolation: "vm",
		},
		desktop: { ready: true, viewers: 2 },
		runningSince: "2026-10-19T10:00:00Z",
		runningSeconds: 600,
		accruedMicroUsd: 11_667,
		ratePerHourMicroUsd: 70_000,
		balanceMicroUsd: -5,
		minutesRemaining: 0,
		warning: "critical",
		stopReason: "balance",
		expiresAt: "2026-10-19T14:00:00Z",
	});
});

test("every view field is optional and unknown enums degrade, not fail", () => {
	expect(parseSessionBoxView({})).toEqual({
		id: null,
		size: null,
		state: null,
		source: null,
		child: null,
		placement: null,
		desktop: null,
		runningSince: null,
		runningSeconds: null,
		accruedMicroUsd: null,
		ratePerHourMicroUsd: null,
		balanceMicroUsd: null,
		minutesRemaining: null,
		warning: "none",
		stopReason: null,
		expiresAt: null,
	});
	const odd = parseSessionBoxView({
		state: "hibernating",
		size: "huge",
		warning: "extreme",
		runningSeconds: -1,
		desktop: { viewers: "many" },
	});
	expect(odd?.state).toBeNull();
	expect(odd?.size).toBeNull();
	expect(odd?.warning).toBe("none");
	expect(odd?.runningSeconds).toBeNull();
	expect(odd?.desktop).toEqual({ ready: false, viewers: 0 });
	expect(parseSessionBoxView(null)).toBeNull();
	expect(parseSessionBoxView(undefined)).toBeNull();
	expect(() => parseSessionBoxView("box")).toThrow();
});

test("parses a status with children and caps, and tolerates a missing box", () => {
	const status = parseSessionBoxStatus({
		conversationId: "conv-1",
		box: null,
		children: [{ ...FULL_VIEW, child: 1, source: "sub_agent" }, "junk"],
		caps: { running: 2, max: 3 },
	});
	expect(status.box).toBeNull();
	expect(status.children).toHaveLength(1);
	expect(status.children[0]?.child).toBe(1);
	expect(status.caps).toEqual({ running: 2, max: 3 });
	expect(parseSessionBoxStatus({ conversationId: "conv-1" })).toEqual({
		conversationId: "conv-1",
		box: null,
		children: [],
		caps: null,
		costNotice: null,
	});
	expect(() => parseSessionBoxStatus({ box: null })).toThrow();
});

test("an older Core's cloud task status without box or caps still parses", () => {
	const task = parseCloudTaskStatus({
		conversationId: "conv-1",
		environmentId: "env-1",
		backend: "box",
		executor: "codex",
		state: "ready",
		expiresAt: null,
		baseSha: null,
		baseBranch: null,
		activeRun: null,
		lastRun: null,
		finish: null,
	});
	expect(task.box).toBeNull();
	expect(task.caps).toBeNull();
});

test("a current Core's cloud task status carries the Box and caps", () => {
	const task = parseCloudTaskStatus({
		conversationId: "conv-1",
		environmentId: "env-1",
		backend: "box",
		executor: "codex",
		state: "ready",
		expiresAt: null,
		baseSha: null,
		baseBranch: null,
		activeRun: null,
		lastRun: null,
		finish: null,
		box: FULL_VIEW,
		caps: { running: 1, max: null },
	});
	expect(task.box?.accruedMicroUsd).toBe(11_667);
	expect(task.caps).toEqual({ running: 1, max: null });
});

test("parses direct and relay screen grants", () => {
	expect(
		parseDesktopGrant({
			mode: "direct",
			url: "wss://box.ryu.test/v1/boxes/b/desktop/ws",
			protocols: ["ryu.box.v1", "ryu.token.t"],
			expiresAt: "2026-10-19T10:00:30Z",
		})
	).toEqual({
		mode: "direct",
		url: "wss://box.ryu.test/v1/boxes/b/desktop/ws",
		protocols: ["ryu.box.v1", "ryu.token.t"],
		expiresAt: "2026-10-19T10:00:30Z",
	});
	expect(
		parseDesktopGrant({
			mode: "relay",
			path: "/api/session-boxes/conv-1/screen/ws",
			protocols: [],
			expiresAt: "2026-10-19T10:01:00Z",
		})
	).toEqual({
		mode: "relay",
		path: "/api/session-boxes/conv-1/screen/ws",
		protocols: [],
		expiresAt: "2026-10-19T10:01:00Z",
	});
});

test("refuses grants that could leak or mis-route a stream", () => {
	// A relative URL is never resolved against the page.
	expect(() =>
		parseDesktopGrant({ mode: "direct", url: "/v1/boxes/b/desktop/ws" })
	).toThrow();
	expect(() =>
		parseDesktopGrant({ mode: "direct", url: "https://box.ryu.test/x" })
	).toThrow();
	expect(() =>
		parseDesktopGrant({ mode: "direct", url: "wss://user:pw@box.ryu.test/x" })
	).toThrow();
	expect(() =>
		parseDesktopGrant({ mode: "relay", path: "/api/ext/ws/anything" })
	).toThrow();
	expect(() => parseDesktopGrant({ mode: "tunnel" })).toThrow();
});

test("builds keys and relay URLs", () => {
	expect(sessionBoxKey("conv-1")).toBe("conv-1");
	expect(sessionBoxKey("conv-1", 2)).toBe("conv-1#sub:2");
	expect(
		sessionBoxRelayUrl(
			{ url: "https://node.example", token: null },
			"/api/session-boxes/conv-1/screen/ws",
			"t-1",
			true
		)
	).toBe(
		"wss://node.example/api/session-boxes/conv-1/screen/ws?ticket=t-1&viewOnly=1"
	);
});

test("connect sends viewOnly and origin, and percent-encodes a child key", async () => {
	const seen: { body: unknown; path: string }[] = [];
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			seen.push({
				path: url.pathname,
				body: init?.body ? JSON.parse(String(init.body)) : null,
			});
			return Promise.resolve(
				Response.json({
					mode: "direct",
					url: "wss://box.ryu.test/v1/boxes/b/desktop/ws",
					protocols: ["ryu.box.v1", "ryu.token.t"],
					expiresAt: null,
				})
			);
		},
		{ preconnect: originalFetch.preconnect }
	);
	const endpoint = await connectSessionBoxScreen(
		{ url: "http://node.test", token: "node", userJwt: "jwt" },
		sessionBoxKey("conv-1", 4),
		{ viewOnly: true, origin: "tauri://localhost" }
	);
	expect(endpoint).toEqual({
		url: "wss://box.ryu.test/v1/boxes/b/desktop/ws",
		protocols: ["ryu.box.v1", "ryu.token.t"],
	});
	expect(seen[0]?.path).toBe("/api/session-boxes/conv-1%23sub%3A4/screen");
	expect(seen[0]?.body).toEqual({
		viewOnly: true,
		origin: "tauri://localhost",
	});
});

test("maps typed refusals to readable messages", async () => {
	const { ApiError } = await import("./client.ts");
	expect(
		sessionBoxErrorMessage(
			new ApiError("/x", 429, "cap", "session_box_limit_reached")
		)
	).toContain("Box limit");
	expect(
		sessionBoxErrorMessage(
			new ApiError("/x", 402, "credits", "session_box_insufficient_credits")
		)
	).toContain("Top up");
	expect(
		sessionBoxErrorMessage(
			new ApiError("/x", 503, "capacity", "session_box_capacity")
		)
	).toContain("capacity");
});
