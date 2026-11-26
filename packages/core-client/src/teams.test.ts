import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	addTeamMember,
	createTeam,
	deleteTeam,
	fetchTeam,
	fetchTeams,
	removeTeamMember,
	updateTeam,
} from "./teams.ts";
import type { HttpFixtureBody } from "./test-support/http-fixture.ts";
import {
	createFetchFixture,
	parseJsonRequestBody,
} from "./test-support/http-fixture.ts";

const realFetch = globalThis.fetch;
const target: ApiTarget = {
	url: "http://127.0.0.1:7980/",
	token: "node",
	userJwt: null,
};

afterEach(() => {
	globalThis.fetch = realFetch;
});

interface CapturedTeamRequest {
	init?: RequestInit;
	url?: string;
}

function stub(body: HttpFixtureBody) {
	let captured: CapturedTeamRequest = {};
	globalThis.fetch = createFetchFixture((url: string, init: RequestInit) => {
		captured = { url, init };
		return Promise.resolve(Response.json(body));
	});
	return () => captured;
}

const wire = {
	created_at: "2026-08-16T00:00:00Z",
	description: null,
	id: "team-1",
	lead_agent_id: "agent-1",
	members: ["agent-1"],
	name: "Review",
	updated_at: "2026-08-16T00:00:00Z",
};

describe("teams client", () => {
	test("normalizes list and unknown coordination values safely", async () => {
		const read = stub({ teams: [{ ...wire, coordination: "future-mode" }] });
		expect(await fetchTeams(target)).toEqual([
			{
				createdAt: wire.created_at,
				description: null,
				id: wire.id,
				leadAgentId: wire.lead_agent_id,
				members: wire.members,
				name: wire.name,
				updatedAt: wire.updated_at,
				coordination: "broadcast",
			},
		]);
		expect(read().url).toBe("http://127.0.0.1:7980/api/teams");
	});

	test("creates with the complete wire contract", async () => {
		const read = stub({ team: { ...wire, coordination: "router" } });
		await createTeam(target, {
			name: "Review",
			members: ["agent-1"],
			coordination: "router",
			leadAgentId: "agent-1",
		});
		expect(read().init?.method).toBe("POST");
		expect(parseJsonRequestBody(read().init?.body)).toEqual({
			name: "Review",
			description: null,
			members: ["agent-1"],
			coordination: "router",
			lead_agent_id: "agent-1",
		});
	});

	test("patches only supplied fields", async () => {
		const read = stub({ team: { ...wire, coordination: "debate-synthesis" } });
		await updateTeam(target, "team?a", {
			name: "Review 2",
			leadAgentId: null,
		});
		expect(read().url).toBe("http://127.0.0.1:7980/api/teams/team%3Fa");
		expect(parseJsonRequestBody(read().init?.body)).toEqual({
			name: "Review 2",
			lead_agent_id: null,
		});
	});

	test("covers fetch, delete, add-member, and remove-member routes", async () => {
		let read = stub({ team: wire });
		await fetchTeam(target, "team?a");
		expect(read().url).toBe("http://127.0.0.1:7980/api/teams/team%3Fa");

		read = stub({ success: true });
		await deleteTeam(target, "team?a");
		expect(read().init?.method).toBe("DELETE");

		read = stub({ team: wire });
		await addTeamMember(target, "team?a", "agent#1");
		expect(read().url).toBe("http://127.0.0.1:7980/api/teams/team%3Fa/members");
		expect(parseJsonRequestBody(read().init?.body)).toEqual({
			agent_id: "agent#1",
		});

		read = stub({ team: wire });
		await removeTeamMember(target, "team?a", "agent#1");
		expect(read().url).toBe(
			"http://127.0.0.1:7980/api/teams/team%3Fa/members/agent%231"
		);
		expect(read().init?.method).toBe("DELETE");
	});

	// Core serves teams through a mount and decodes the path once, so a slash
	// that left as `%2F` would be a separator again there.
	test("refuses a team or agent id that holds a path separator", async () => {
		let read = stub({ team: wire });
		await expect(fetchTeam(target, "team/a")).rejects.toThrow("path separator");
		await expect(deleteTeam(target, "team/a/members/agent-1")).rejects.toThrow(
			"path separator"
		);
		await expect(removeTeamMember(target, "team-1", "agent/1")).rejects.toThrow(
			"path separator"
		);
		expect(read().url).toBeUndefined();

		// The agent id of addTeamMember travels in the body, not in the path.
		read = stub({ team: wire });
		await addTeamMember(target, "team-1", "agent/1");
		expect(read().url).toBe("http://127.0.0.1:7980/api/teams/team-1/members");
	});
});
