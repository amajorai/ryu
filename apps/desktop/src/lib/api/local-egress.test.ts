import { describe, expect, it } from "bun:test";
import { routableNodes } from "./local-egress.ts";
import type { ManagedNode } from "./managed-nodes.ts";

function node(overrides: Partial<ManagedNode>): ManagedNode {
	return {
		id: "node-1",
		lastSeenAt: null,
		name: "Cloud",
		orgId: "org-1",
		orgName: null,
		ownerUserId: "user-1",
		scope: "personal",
		url: "https://node.example:7980",
		userJwt: "jwt",
		...overrides,
	};
}

describe("desktop egress route targets", () => {
	it("routes only nodes the signed-in user owns with a live credential", () => {
		const managed = [
			node({}),
			node({ id: "shared", ownerUserId: null, scope: "org" }),
			node({ id: "someone-else", ownerUserId: "user-2" }),
			node({ id: "no-url", url: " " }),
			node({ id: "no-token", userJwt: null }),
		];
		expect(routableNodes(managed, "user-1")).toEqual([
			{ nodeId: "node-1", token: "jwt", url: "https://node.example:7980" },
		]);
	});

	it("routes nothing while signed out", () => {
		expect(routableNodes([node({})], null)).toEqual([]);
	});
});
