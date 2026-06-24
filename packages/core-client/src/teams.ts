// apps/desktop/src/lib/api/teams.ts
//
// Typed client for Core's agent-team endpoints (`/api/teams`). A team is a named,
// ordered collection of agent ids plus a coordination strategy that decides how
// the members respond when the team is addressed as one unit (`@team` in chat).
// All orchestration logic lives in Core; this client only does CRUD + member
// management (the drag-an-agent-into-a-team gesture posts to the members route).

import { type ApiTarget, request } from "./client.ts";

/** How a team's members respond when the team is called. Mirrors Core's enum. */
export type Coordination =
	| "broadcast"
	| "round-robin"
	| "debate-synthesis"
	| "router";

/** User-facing labels + one-line descriptions for the coordination picker. */
export const COORDINATION_OPTIONS: ReadonlyArray<{
	value: Coordination;
	label: string;
	description: string;
}> = [
	{
		value: "broadcast",
		label: "Broadcast",
		description: "Every member answers independently, side by side.",
	},
	{
		value: "round-robin",
		label: "Round-robin",
		description: "Members answer in order, each building on the last.",
	},
	{
		value: "debate-synthesis",
		label: "Debate + synthesis",
		description: "Members answer, then a lead merges one answer.",
	},
	{
		value: "router",
		label: "Smart router",
		description: "Routes to the single best-suited member.",
	},
];

/** A persisted team record returned by the team endpoints. */
export interface Team {
	coordination: Coordination;
	createdAt: string | null;
	description: string | null;
	id: string;
	/** Synthesizer (debate) / classifier (router); falls back to first member. */
	leadAgentId: string | null;
	/** Ordered member agent ids. */
	members: string[];
	name: string;
	updatedAt: string | null;
}

/** Fields the UI sends when creating a team. */
export interface CreateTeamInput {
	coordination?: Coordination;
	description?: string | null;
	leadAgentId?: string | null;
	members?: string[];
	name: string;
}

/** Patch fields for updating a team. Absent fields are left unchanged. */
export interface UpdateTeamInput {
	coordination?: Coordination;
	description?: string | null;
	/** `null` clears the lead; omit to leave unchanged. */
	leadAgentId?: string | null;
	members?: string[];
	name?: string;
}

interface TeamWire {
	coordination?: string | null;
	created_at?: string | null;
	description?: string | null;
	id: string;
	lead_agent_id?: string | null;
	members?: string[];
	name: string;
	updated_at?: string | null;
}

function toCoordination(raw: string | null | undefined): Coordination {
	switch (raw) {
		case "round-robin":
			return "round-robin";
		case "debate-synthesis":
			return "debate-synthesis";
		case "router":
			return "router";
		default:
			return "broadcast";
	}
}

function toTeam(t: TeamWire): Team {
	return {
		id: t.id,
		name: t.name,
		description: t.description ?? null,
		members: t.members ?? [],
		coordination: toCoordination(t.coordination),
		leadAgentId: t.lead_agent_id ?? null,
		createdAt: t.created_at ?? null,
		updatedAt: t.updated_at ?? null,
	};
}

export async function fetchTeams(target: ApiTarget): Promise<Team[]> {
	const json = await request<{ teams?: TeamWire[] }>(target, "/api/teams");
	return (json.teams ?? []).map(toTeam);
}

export async function fetchTeam(target: ApiTarget, id: string): Promise<Team> {
	const json = await request<{ team: TeamWire }>(target, `/api/teams/${id}`);
	return toTeam(json.team);
}

export async function createTeam(
	target: ApiTarget,
	input: CreateTeamInput
): Promise<Team> {
	const json = await request<{ team: TeamWire }>(target, "/api/teams", {
		method: "POST",
		body: {
			name: input.name,
			description: input.description ?? null,
			members: input.members ?? [],
			coordination: input.coordination ?? "broadcast",
			lead_agent_id: input.leadAgentId ?? null,
		},
	});
	return toTeam(json.team);
}

export async function updateTeam(
	target: ApiTarget,
	id: string,
	input: UpdateTeamInput
): Promise<Team> {
	const body: Record<string, unknown> = {};
	if (input.name !== undefined) {
		body.name = input.name;
	}
	if (input.description !== undefined) {
		body.description = input.description;
	}
	if (input.members !== undefined) {
		body.members = input.members;
	}
	if (input.coordination !== undefined) {
		body.coordination = input.coordination;
	}
	if (input.leadAgentId !== undefined) {
		body.lead_agent_id = input.leadAgentId;
	}
	const json = await request<{ team: TeamWire }>(target, `/api/teams/${id}`, {
		method: "PATCH",
		body,
	});
	return toTeam(json.team);
}

export async function deleteTeam(target: ApiTarget, id: string): Promise<void> {
	await request<void>(target, `/api/teams/${id}`, { method: "DELETE" });
}

/** Add one agent to a team (the drag-an-agent-into-a-team gesture). */
export async function addTeamMember(
	target: ApiTarget,
	teamId: string,
	agentId: string
): Promise<Team> {
	const json = await request<{ team: TeamWire }>(
		target,
		`/api/teams/${teamId}/members`,
		{ method: "POST", body: { agent_id: agentId } }
	);
	return toTeam(json.team);
}

/** Remove one agent from a team. */
export async function removeTeamMember(
	target: ApiTarget,
	teamId: string,
	agentId: string
): Promise<Team> {
	const json = await request<{ team: TeamWire }>(
		target,
		`/api/teams/${teamId}/members/${agentId}`,
		{ method: "DELETE" }
	);
	return toTeam(json.team);
}
