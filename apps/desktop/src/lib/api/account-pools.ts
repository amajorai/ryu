// apps/desktop/src/lib/api/account-pools.ts
//
// Typed client for Core's custom account pools
// (`/api/pi-config/providers/account-pools`). A pool is a named set of saved
// provider accounts. An agent that is limited to a pool rotates only over that
// pool's accounts. An agent on Auto tries every saved account of a provider,
// one after another, and an agent's backup models run in order when no account
// can serve the model a request names. Pools, assignments and backups hold ids
// and model names only, never a credential.

import { z } from "zod";
import { ApiError, type ApiTarget, request } from "./client.ts";

/** One saved account, named by the provider that lists it and its vault id. */
export interface AccountPoolMember {
	accountId: string;
	providerId: string;
}

export interface AccountPool {
	accounts: AccountPoolMember[];
	id: string;
	name: string;
}

/** One backup model of an agent: a model on a provider. */
export interface BackupModel {
	model: string;
	providerId: string;
}

/** Which accounts an agent may use: all as before, Auto, or one pool. */
export type AgentAccountMode = "none" | "auto" | "pool";

export interface AccountPoolCatalog {
	/** Agent id to pool id. An agent that is absent has no pool. */
	agents: Record<string, string>;
	/** Agents on Auto. Absent on a Core without Auto. */
	auto?: string[];
	/** Agent id to its backup models, in the order they are tried. */
	backups?: Record<string, BackupModel[]>;
	/** Present only on a Core that has Auto and backups. */
	maxBackups?: number;
	maxPoolAccounts: number;
	maxPools: number;
	pools: AccountPool[];
}

export interface AgentAccountPool {
	agentId: string;
	backups?: BackupModel[];
	mode?: AgentAccountMode;
	/** `null` when the agent has no pool. */
	poolId: string | null;
}

const memberSchema = z.object({
	accountId: z.string(),
	providerId: z.string(),
});
const poolSchema: z.ZodType<AccountPool> = z.object({
	accounts: z.array(memberSchema),
	id: z.string(),
	name: z.string(),
});
const backupSchema = z.object({
	model: z.string(),
	providerId: z.string(),
});
const catalogSchema: z.ZodType<AccountPoolCatalog> = z.object({
	agents: z.record(z.string(), z.string()),
	auto: z.array(z.string()).optional(),
	backups: z.record(z.string(), z.array(backupSchema)).optional(),
	maxBackups: z.number().optional(),
	maxPoolAccounts: z.number(),
	maxPools: z.number(),
	pools: z.array(poolSchema),
});
const assignmentSchema: z.ZodType<AgentAccountPool> = z.object({
	agentId: z.string(),
	backups: z.array(backupSchema).optional(),
	mode: z.enum(["none", "auto", "pool"]).optional(),
	poolId: z.string().nullable(),
});

const BASE = "/api/pi-config/providers/account-pools";

/** One cache entry per node: the settings page and every agent panel share it. */
export function accountPoolsQueryKey(target: ApiTarget) {
	return ["account-pools", target.url] as const;
}

/** The stable key of a member inside a pool editor. */
export function memberKey(member: AccountPoolMember): string {
	return `${member.providerId}\u0000${member.accountId}`;
}

/** `members` with `member` added when absent and removed when present. */
export function toggleMember(
	members: AccountPoolMember[],
	member: AccountPoolMember
): AccountPoolMember[] {
	const key = memberKey(member);
	return members.some((entry) => memberKey(entry) === key)
		? members.filter((entry) => memberKey(entry) !== key)
		: [...members, member];
}

/**
 * Whether a failed read means the node has no account pool routes at all (an
 * older Core answers 404). The pool surfaces are then left out, because there
 * is nothing the user could do with them on that node.
 */
export function accountPoolsUnsupported(error: unknown): boolean {
	return error instanceof ApiError && error.status === 404;
}

/** Whether the node's Core knows Auto and backup models. */
export function supportsAutoMode(catalog: AccountPoolCatalog): boolean {
	return typeof catalog.maxBackups === "number";
}

/** What an agent uses, read from the shared catalog. */
export function agentAccountMode(
	catalog: AccountPoolCatalog,
	agentId: string
): AgentAccountMode {
	if (catalog.agents[agentId] !== undefined) {
		return "pool";
	}
	return catalog.auto?.includes(agentId) ? "auto" : "none";
}

/** `list` with the entry at `index` moved one place up (-1) or down (1). */
export function moveBackup(
	list: BackupModel[],
	index: number,
	step: -1 | 1
): BackupModel[] {
	const to = index + step;
	if (index < 0 || index >= list.length || to < 0 || to >= list.length) {
		return list;
	}
	const next = [...list];
	const [entry] = next.splice(index, 1);
	next.splice(to, 0, entry as BackupModel);
	return next;
}

/** Every pool, the pool of each agent, and Core's limits. */
export async function fetchAccountPools(
	target: ApiTarget
): Promise<AccountPoolCatalog> {
	return await request<AccountPoolCatalog>(target, BASE, {}, catalogSchema);
}

export async function createAccountPool(
	target: ApiTarget,
	input: { accounts: AccountPoolMember[]; name: string }
): Promise<AccountPool> {
	return await request<AccountPool>(
		target,
		BASE,
		{ method: "POST", body: input },
		poolSchema
	);
}

/** Rename a pool, replace its accounts, or both. A missing part is kept. */
export async function updateAccountPool(
	target: ApiTarget,
	poolId: string,
	input: { accounts?: AccountPoolMember[]; name?: string }
): Promise<AccountPool> {
	return await request<AccountPool>(
		target,
		`${BASE}/${encodeURIComponent(poolId)}`,
		{ method: "PUT", body: input },
		poolSchema
	);
}

/** Delete a pool. Core clears it from every agent that had it. */
export async function deleteAccountPool(
	target: ApiTarget,
	poolId: string
): Promise<void> {
	await request<undefined>(
		target,
		`${BASE}/${encodeURIComponent(poolId)}`,
		{ method: "DELETE" },
		z.undefined()
	);
}

/** Limit an agent to one pool, or pass `null` to clear its pool. */
export async function setAgentAccountPool(
	target: ApiTarget,
	agentId: string,
	poolId: string | null
): Promise<AgentAccountPool> {
	return await request<AgentAccountPool>(
		target,
		`${BASE}/agents/${encodeURIComponent(agentId)}`,
		{ method: "PUT", body: { poolId } },
		assignmentSchema
	);
}

/**
 * Put an agent on Auto, on one pool (`poolId` is then required) or on
 * neither, and replace its backup models when `backups` is given. A missing
 * `backups` keeps the stored list.
 */
export async function setAgentAccountMode(
	target: ApiTarget,
	agentId: string,
	input: {
		backups?: BackupModel[];
		mode: AgentAccountMode;
		poolId?: string | null;
	}
): Promise<AgentAccountPool> {
	const body: Record<string, unknown> = { mode: input.mode };
	if (input.mode === "pool") {
		body.poolId = input.poolId ?? null;
	}
	if (input.backups) {
		body.backups = input.backups;
	}
	return await request<AgentAccountPool>(
		target,
		`${BASE}/agents/${encodeURIComponent(agentId)}`,
		{ method: "PUT", body },
		assignmentSchema
	);
}
