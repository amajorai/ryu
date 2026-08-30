import { describe, expect, test } from "bun:test";
import { shareOriginsForNode } from "./node-share.ts";

const mesh = {
	backend: "tailscale",
	backendState: "Running",
	controlServer: null,
	magicDnsName: "host.tailnet.ts.net",
	peers: [],
	tailscaleIps: ["100.64.0.10"],
	tailcatAddress: null,
	enabled: true,
	reachable: true,
};

describe("shareOriginsForNode", () => {
	test("does not share loopback-only active nodes", () => {
		expect(shareOriginsForNode({ url: "http://127.0.0.1:7980" }, null)).toEqual(
			[]
		);
	});

	test("shares a reachable active LAN origin without credentials", () => {
		expect(
			shareOriginsForNode({ url: "http://192.168.1.20:7980" }, null)
		).toEqual([
			{ origin: "http://192.168.1.20:7980", source: "active", reachable: true },
		]);
	});

	test("preserves a secure public active origin", () => {
		expect(shareOriginsForNode({ url: "https://node.example" }, null)).toEqual([
			{ origin: "https://node.example", source: "active", reachable: true },
		]);
	});

	test("adds only Core-confirmed mesh origins and never returns credentials", () => {
		expect(shareOriginsForNode({ url: "http://127.0.0.1:7980" }, mesh)).toEqual(
			[
				{
					origin: "http://host.tailnet.ts.net:7980",
					source: "mesh",
					reachable: true,
				},
				{ origin: "http://100.64.0.10:7980", source: "mesh", reachable: true },
			]
		);
		expect(
			JSON.stringify(
				shareOriginsForNode({ url: "http://127.0.0.1:7980" }, mesh)
			)
		).not.toContain("token");
	});

	test("rejects URLs that smuggle a path, query, or credential", () => {
		expect(
			shareOriginsForNode(
				{ url: "https://user:pass@node.example/path?token=secret" },
				null
			)
		).toEqual([]);
	});
});
