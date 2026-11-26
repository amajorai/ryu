// packages/core-client/src/vault/password-manager.test.ts
//
// The MCP broker passes a model's proposal id to vaultAgentBrokerProposal
// (apps/mcp/src/broker-tools.ts). Its request goes through machineRequest,
// outside the dot segment net of `apiUrl`, so the builder itself refuses "."
// and ".." (encodePathId) and keeps every other id in one segment.

import { describe, expect, test } from "bun:test";
import type { VaultAgentTarget } from "./agent-routes.ts";
import { vaultAgentBrokerProposal } from "./password-manager.ts";

const BASE = "http://core.test";
const PROPOSALS = `${BASE}/api/vault/agent/broker/proposals`;

/** An agent target whose stub fetch records every request and answers with an empty object. */
function recordingTarget(): { requests: string[]; target: VaultAgentTarget } {
	const requests: string[] = [];
	const target: VaultAgentTarget = {
		url: BASE,
		vaultToken: "rvt_test",
		fetch: (input, init) => {
			requests.push(`${init?.method ?? "GET"} ${String(input)}`);
			return Promise.resolve(Response.json({}));
		},
	};
	return { requests, target };
}

async function requestsFor(id: string): Promise<string[]> {
	const { requests, target } = recordingTarget();
	await Promise.resolve()
		.then(() => vaultAgentBrokerProposal(target, id))
		.catch(() => undefined);
	return requests;
}

describe("vaultAgentBrokerProposal", () => {
	for (const id of [".", ".."]) {
		test(`builds no request for the proposal id ${id}`, async () => {
			expect(await requestsFor(id)).toEqual([]);
		});
	}

	test("keeps a slash, a query and a fragment inside the segment", async () => {
		expect(await requestsFor("bp_1/../x?y#z")).toEqual([
			`GET ${PROPOSALS}/bp_1%2F..%2Fx%3Fy%23z`,
		]);
	});

	test("asks for a plain proposal id unchanged", async () => {
		expect(await requestsFor("bp_0123456789abcdef")).toEqual([
			`GET ${PROPOSALS}/bp_0123456789abcdef`,
		]);
	});
});
