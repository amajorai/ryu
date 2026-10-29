import { z } from "zod";
import { defaultAuthorizeScopes, parseOAuthScopes } from "../scopes.ts";

/**
 * An authorize request that omits `scope` asks, in Better Auth, for every
 * scope the client is registered for (or every supported scope when the
 * client has none on record), opt-in scopes such as `mail:manage` included,
 * and a skip-consent client would get them without a consent screen. A
 * dynamically registered or CIMD client is always stored with every
 * registrable scope, `mail:manage` included, so its stored row grants nothing
 * by itself. This fills in the default scope instead, so an opt-in scope is
 * only ever requested when the client asks for it by name
 * (`OAUTH_OPT_IN_SCOPES` in `../scopes.ts`).
 *
 * `/oauth2/authorize` accepts GET (parameters in the query) and POST
 * (parameters in the form body; Better Auth reads only the body for a POST),
 * so both are defaulted.
 */

const authorizeQuerySchema = z
	.looseObject({
		client_id: z.string().min(1).optional().catch(undefined),
		request_uri: z.unknown().optional(),
		scope: z.unknown().optional(),
	})
	.catch(() => ({}));

/** Reads a client's registered scopes, or null when none are on record. */
export type FindClientScopes = (
	clientId: string
) => Promise<readonly string[] | null>;

/**
 * The `scope` to put on an `/oauth2/authorize` query that has none, or null
 * to leave the query as it is: it already names a scope (an empty `scope`
 * asks for nothing, which Better Auth honours), it is a pushed authorization
 * request (`request_uri`), or it names no client (Better Auth refuses it).
 */
export async function scopeForAuthorizeWithoutScope(
	query: unknown,
	findClientScopes: FindClientScopes
): Promise<string | null> {
	const parsed = authorizeQuerySchema.parse(query);
	if (
		parsed.scope !== undefined ||
		parsed.request_uri !== undefined ||
		!parsed.client_id
	) {
		return null;
	}
	return defaultAuthorizeScopes(await findClientScopes(parsed.client_id)).join(
		" "
	);
}

/** The request parts {@link authorizeScopeDefaults} reads. */
export interface AuthorizeRequestParts {
	body?: unknown;
	method?: string;
	query?: unknown;
}

/** The replacement query or body for an authorize request without `scope`. */
export type AuthorizeScopeDefaults =
	| { body: Record<string, unknown> }
	| { query: Record<string, unknown> };

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? { ...(value as Record<string, unknown>) }
		: {};
}

/**
 * The query (GET) or form body (POST) to use for an `/oauth2/authorize`
 * request that has no `scope`, or null to leave the request as it is (see
 * {@link scopeForAuthorizeWithoutScope}). It reads the same part of the
 * request Better Auth reads: the body for a POST, the query otherwise.
 */
export async function authorizeScopeDefaults(
	request: AuthorizeRequestParts,
	findClientScopes: FindClientScopes
): Promise<AuthorizeScopeDefaults | null> {
	const isPost = request.method?.toUpperCase() === "POST";
	const parameters = asRecord(isPost ? request.body : request.query);
	const scope = await scopeForAuthorizeWithoutScope(
		parameters,
		findClientScopes
	);
	if (scope === null) {
		return null;
	}
	return isPost
		? { body: { ...parameters, scope } }
		: { query: { ...parameters, scope } };
}

/** A stored client row's scopes, or null when the row records none. */
export function registeredClientScopes(
	row: { scopes?: unknown } | null | undefined
): readonly string[] | null {
	if (row?.scopes === undefined || row.scopes === null) {
		return null;
	}
	return parseOAuthScopes(row.scopes);
}

/** The adapter read {@link authorizeScopeDefaultsFromStore} needs. */
export interface OAuthClientStore {
	findOne<T>(query: {
		model: string;
		where: { field: string; value: string }[];
	}): Promise<T | null>;
}

/**
 * {@link authorizeScopeDefaults} with the client's scopes read from its stored
 * `oauthClient` row. `hooks.before` in `../index.ts` merges the result into
 * the request context for `/oauth2/authorize`.
 */
export function authorizeScopeDefaultsFromStore(
	request: AuthorizeRequestParts,
	store: OAuthClientStore
): Promise<AuthorizeScopeDefaults | null> {
	return authorizeScopeDefaults(request, async (clientId) =>
		registeredClientScopes(
			await store.findOne<{ scopes?: unknown }>({
				model: "oauthClient",
				where: [{ field: "clientId", value: clientId }],
			})
		)
	);
}
