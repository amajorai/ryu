// apps/desktop/src/lib/api/teams.ts
//
// Typed client for Core's agent-team endpoints (`/api/teams`). A team is a named,
// ordered collection of agent ids plus a coordination strategy that decides how
// the members respond when the team is addressed as one unit (`@team` in chat).
// All orchestration logic lives in Core; this client only does CRUD + member
// management (the drag-an-agent-into-a-team gesture posts to the members route).

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";

/** How a team's members respond when the team is called. Mirrors Core's enum. */
export type Coordination =
	| "broadcast"
	| "round-robin"
	| "debate-synthesis"
	| "router";

/** User-facing labels + one-line descriptions for the coordination picker. */
interface CoordinationOption {
	description: string;
	label: string;
	value: Coordination;
}
export const COORDINATION_OPTIONS: readonly CoordinationOption[] = [
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

// Full native TeamRecord; preserve existing older-node optional fields and
// lenient future coordination fallback before the unchanged UI normalization.
const teamFieldsSchema = z.object({
	coordination: z.string().nullish(),
	created_at: z.string().nullish(),
	description: z.string().nullish(),
	id: z.string(),
	lead_agent_id: z.string().nullish(),
	members: z.array(z.string()).nullish(),
	name: z.string(),
	updated_at: z.string().nullish(),
});
export const teamResponseSchema = z.custom<z.output<typeof teamFieldsSchema>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		teamFieldsSchema.safeParse(value).success
);
type TeamWire = z.output<typeof teamResponseSchema>;
const teamListFieldsSchema = z.object({
	teams: z.array(teamResponseSchema).nullish(),
});
const teamListResponseSchema = z.custom<z.output<typeof teamListFieldsSchema>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		teamListFieldsSchema.safeParse(value).success
);
const teamEnvelopeFieldsSchema = z.object({ team: teamResponseSchema });
const teamEnvelopeResponseSchema = z.custom<
	z.output<typeof teamEnvelopeFieldsSchema>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		teamEnvelopeFieldsSchema.safeParse(value).success
);
const teamDeleteFieldsSchema = z.object({ success: z.boolean() });
const teamDeleteResponseSchema = z.custom<
	z.output<typeof teamDeleteFieldsSchema>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		teamDeleteFieldsSchema.safeParse(value).success
);

type TeamPatchWire = Omit<UpdateTeamInput, "leadAgentId"> & {
	lead_agent_id?: string | null;
};

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
	const json = await request(target, "/api/teams", {}, teamListResponseSchema);
	return (json.teams ?? []).map(toTeam);
}

export async function fetchTeam(target: ApiTarget, id: string): Promise<Team> {
	const json = await request(
		target,
		`/api/teams/${id}`,
		{},
		teamEnvelopeResponseSchema
	);
	return toTeam(json.team);
}

export async function createTeam(
	target: ApiTarget,
	input: CreateTeamInput
): Promise<Team> {
	const json = await request(
		target,
		"/api/teams",
		{
			method: "POST",
			body: {
				name: input.name,
				description: input.description ?? null,
				members: input.members ?? [],
				coordination: input.coordination ?? "broadcast",
				lead_agent_id: input.leadAgentId ?? null,
			},
		},
		teamEnvelopeResponseSchema
	);
	return toTeam(json.team);
}

export async function updateTeam(
	target: ApiTarget,
	id: string,
	input: UpdateTeamInput
): Promise<Team> {
	const body: TeamPatchWire = {};
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
	const json = await request(
		target,
		`/api/teams/${id}`,
		{
			method: "PATCH",
			body,
		},
		teamEnvelopeResponseSchema
	);
	return toTeam(json.team);
}

export async function deleteTeam(target: ApiTarget, id: string): Promise<void> {
	await request(
		target,
		`/api/teams/${id}`,
		{ method: "DELETE" },
		teamDeleteResponseSchema
	);
}

/** Add one agent to a team (the drag-an-agent-into-a-team gesture). */
export async function addTeamMember(
	target: ApiTarget,
	teamId: string,
	agentId: string
): Promise<Team> {
	const json = await request(
		target,
		`/api/teams/${teamId}/members`,
		{ method: "POST", body: { agent_id: agentId } },
		teamEnvelopeResponseSchema
	);
	return toTeam(json.team);
}

/** Remove one agent from a team. */
export async function removeTeamMember(
	target: ApiTarget,
	teamId: string,
	agentId: string
): Promise<Team> {
	const json = await request(
		target,
		`/api/teams/${teamId}/members/${agentId}`,
		{ method: "DELETE" },
		teamEnvelopeResponseSchema
	);
	return toTeam(json.team);
}
