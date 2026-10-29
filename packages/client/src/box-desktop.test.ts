import { describe, expect, test } from "bun:test";
import { createBoxClient } from "./box.ts";

interface Seen {
	body: string | null;
	method: string;
	url: string;
}

function client(
	respond: (seen: Seen) => Response,
	baseUrl = "https://box.example/"
) {
	const calls: Seen[] = [];
	const api = createBoxClient({
		apiKey: "box-key",
		baseUrl,
		fetch: async (input, init) => {
			const seen: Seen = {
				body: typeof init?.body === "string" ? init.body : null,
				method: init?.method ?? "GET",
				url: String(input),
			};
			calls.push(seen);
			return respond(seen);
		},
	});
	return { api, calls };
}

const box = {
	allowedHosts: [],
	createdAt: "2026-10-19T00:00:00.000Z",
	driver: "vm",
	envNames: [],
	id: "bx_1",
	image: "ubuntu:24.04",
	lastError: null,
	name: "box",
	network: "none",
	repo: null,
	secrets: [],
	size: "small",
	snapshotId: null,
	status: "stopping",
	stoppedAt: null,
	ttlSeconds: null,
	updatedAt: "2026-10-19T00:00:00.000Z",
};

describe("Box desktop SDK", () => {
	test("mints a desktop token and keeps the service's absolute URL", async () => {
		const { api, calls } = client(() =>
			Response.json(
				{
					expiresAt: "2026-10-19T00:00:30.000Z",
					protocols: ["ryu.box.v1", "ryu.token.tok"],
					token: "tok",
					url: "wss://ingress.example/v1/boxes/bx_1/desktop/ws",
				},
				{ status: 201 }
			)
		);
		const token = await api.accessToken("bx_1", {
			origin: "https://app.ryu.dev",
			scope: "desktop",
			sub: "user_1",
		});
		expect(calls[0]?.url).toBe(
			"https://box.example/v1/boxes/bx_1/access-tokens"
		);
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			origin: "https://app.ryu.dev",
			scope: "desktop",
			sub: "user_1",
			viewOnly: false,
		});
		expect(token).toEqual({
			expiresAt: "2026-10-19T00:00:30.000Z",
			protocols: ["ryu.box.v1", "ryu.token.tok"],
			token: "tok",
			url: "wss://ingress.example/v1/boxes/bx_1/desktop/ws",
		});
		expect(token.url).not.toContain("tok");
	});

	test("builds the desktop URL from baseUrl when the service sends none", async () => {
		const { api, calls } = client(
			() =>
				Response.json(
					{
						expiresAt: "x",
						protocols: ["ryu.box.v1", "ryu.token.t"],
						token: "t",
					},
					{ status: 201 }
				),
			"http://127.0.0.1:8090"
		);
		const token = await api.accessToken("bx_1", {
			origin: "http://localhost:3001",
			scope: "desktop",
			sub: "u",
			viewOnly: true,
		});
		expect(JSON.parse(calls[0]?.body ?? "{}").viewOnly).toBe(true);
		expect(token.url).toBe("ws://127.0.0.1:8090/v1/boxes/bx_1/desktop/ws");
	});

	test("rejects a relative or token-less desktop answer", async () => {
		const relative = client(() =>
			Response.json({
				expiresAt: "x",
				protocols: ["ryu.box.v1"],
				token: "t",
				url: "/v1/boxes/bx_1/desktop/ws",
			})
		);
		await expect(
			relative.api.accessToken("bx_1", {
				origin: "https://a.dev",
				scope: "desktop",
				sub: "u",
			})
		).rejects.toThrow();
		const tokenInUrl = client(() =>
			Response.json({
				expiresAt: "x",
				protocols: ["ryu.box.v1"],
				token: "t",
				url: "wss://box.example.com/v1/boxes/bx_1/desktop/ws?access_token=t",
			})
		);
		await expect(
			tokenInUrl.api.accessToken("bx_1", {
				origin: "https://a.dev",
				scope: "desktop",
				sub: "u",
			})
		).rejects.toThrow();
		const noProtocols = client(() =>
			Response.json({ expiresAt: "x", protocols: [], token: "t" })
		);
		await expect(
			noProtocols.api.accessToken("bx_1", {
				origin: "https://a.dev",
				scope: "desktop",
				sub: "u",
			})
		).rejects.toThrow();
	});

	test("terminal tokens keep their behaviour", async () => {
		const { api, calls } = client(() =>
			Response.json({
				expiresAt: "x",
				token: "t",
				url: "/v1/boxes/bx_1/terminal?access_token=t",
			})
		);
		const token = await api.accessToken("bx_1", "terminal");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ scope: "terminal" });
		expect(token.url).toBe(
			"wss://box.example/v1/boxes/bx_1/terminal?access_token=t"
		);
	});

	test("reads limits", async () => {
		const limits = {
			maxResourceUnits: 6,
			maxRunning: 3,
			maxStored: 20,
			resourceUnits: 2,
			running: 1,
			stored: 4,
		};
		const { api, calls } = client(() => Response.json(limits));
		expect(await api.limits()).toEqual(limits);
		expect(calls[0]?.url).toBe("https://box.example/v1/limits");
		const broken = client(() => Response.json({ running: 1 }));
		await expect(broken.api.limits()).rejects.toThrow();
	});

	test("parses stopping Boxes with placement and desktop", async () => {
		const full = {
			...box,
			desktop: { height: 800, ready: true, viewers: 0, width: 1280 },
			placement: {
				isolation: "vm",
				location: "hel1",
				provider: "hetzner",
				serverType: "cx23",
				tier: "hetzner",
			},
			runningSince: null,
		};
		const { api } = client(() => Response.json({ box: full }));
		const parsed = await api.get("bx_1");
		expect(parsed.status).toBe("stopping");
		expect(parsed.placement?.serverType).toBe("cx23");
		const old = client(() =>
			Response.json({ box: { ...box, status: "ready" } })
		);
		expect((await old.api.get("bx_1")).desktop).toBeUndefined();
	});
});
