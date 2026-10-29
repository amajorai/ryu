// packages/services/src/managed-agents/iterate.ts
//
// `iterate()` for the Managed Agents collections: `cursor` in, `nextCursor`
// out, items in `data` (design §5). Each page is one `list()` call on the
// wrapped client, so the call's fetch shim (retries, timeouts, typed errors)
// applies to every page. The iterator ends on a null `nextCursor`, an empty
// page, a repeated cursor, or `maxItems`.

import type {
	ManagedAgent,
	ManagedAgentEnvironment,
	ManagedAgentSession,
	ManagedAgentsAPI,
	ManagedAgentsList,
} from "@ryuhq/client";
import { nextCursorField, type Paginated, paginate } from "../pagination.ts";

type ListQuery<F> = F extends (query?: infer Q) => unknown
	? NonNullable<Q>
	: never;

/** `agents.list()` filters, without the cursor the iterator manages. */
export type ManagedAgentIterateQuery = Omit<
	ListQuery<ManagedAgentsAPI["agents"]["list"]>,
	"cursor"
> & { maxItems?: number };

/** `environments.list()` filters, without the cursor the iterator manages. */
export type ManagedAgentEnvironmentIterateQuery = Omit<
	ListQuery<ManagedAgentsAPI["environments"]["list"]>,
	"cursor"
> & { maxItems?: number };

/** `sessions.list()` filters, without the cursor the iterator manages. */
export type ManagedAgentSessionIterateQuery = Omit<
	ListQuery<ManagedAgentsAPI["sessions"]["list"]>,
	"cursor"
> & { maxItems?: number };

function iterateList<Item, Query extends { maxItems?: number }>(
	list: (
		query: Omit<Query, "maxItems"> & { cursor?: string }
	) => Promise<ManagedAgentsList<Item>>,
	query: Query
): Paginated<Item, ManagedAgentsList<Item>> {
	const { maxItems, ...filters } = query;
	return paginate<ManagedAgentsList<Item>, Item>({
		fetchPage: (cursor) =>
			list(cursor === null ? filters : { ...filters, cursor }),
		items: (page) => page.data,
		maxItems,
		nextCursor: nextCursorField,
	});
}

/** Every agent, newest first, across pages. */
export function iterateAgents(
	client: ManagedAgentsAPI,
	query: ManagedAgentIterateQuery = {}
): Paginated<ManagedAgent, ManagedAgentsList<ManagedAgent>> {
	return iterateList((page) => client.agents.list(page), query);
}

/** Every environment, newest first, across pages. */
export function iterateEnvironments(
	client: ManagedAgentsAPI,
	query: ManagedAgentEnvironmentIterateQuery = {}
): Paginated<
	ManagedAgentEnvironment,
	ManagedAgentsList<ManagedAgentEnvironment>
> {
	return iterateList((page) => client.environments.list(page), query);
}

/** Every session visible to the caller, newest first, across pages. */
export function iterateSessions(
	client: ManagedAgentsAPI,
	query: ManagedAgentSessionIterateQuery = {}
): Paginated<ManagedAgentSession, ManagedAgentsList<ManagedAgentSession>> {
	return iterateList((page) => client.sessions.list(page), query);
}
