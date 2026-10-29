import { APIError } from "better-auth/api";
import { z } from "zod";

/*
 * API-key metadata is server-only (docs/managed-agents-spec.md §2 D1, §6).
 *
 * Better Auth's native `/api-key/create` and `/api-key/update` accept `metadata` from a client
 * when `enableMetadata` is on, and Ryu once read a key's owner class from that metadata. The key
 * class and organization now come from the stored `configId` and `referenceId`, and this guard
 * keeps clients from writing metadata at all. The control plane mints keys through server calls
 * (`auth.api.createApiKey` with neither a request nor headers), which the guard leaves alone.
 */

const API_KEY_METADATA_PATHS: ReadonlySet<string> = new Set([
	"/api-key/create",
	"/api-key/update",
]);

const metadataBodySchema = z.object({ metadata: z.unknown() });

/** The fields of a Better Auth hook context the guard reads. */
export interface ApiKeyMetadataGuardContext {
	readonly body?: unknown;
	readonly headers?: unknown;
	readonly path?: string;
	readonly request?: unknown;
}

/**
 * Reject a client create or update of an API key that carries `metadata`. "Client" uses the
 * api-key plugin's own test (`ctx.request || ctx.headers`), so a server call is unaffected.
 */
export function rejectClientApiKeyMetadata(
	ctx: ApiKeyMetadataGuardContext
): void {
	if (!(ctx.path && API_KEY_METADATA_PATHS.has(ctx.path))) {
		return;
	}
	if (!(ctx.request || ctx.headers)) {
		return;
	}
	const body = metadataBodySchema.safeParse(ctx.body);
	if (!body.success || body.data.metadata === undefined) {
		return;
	}
	throw new APIError("BAD_REQUEST", { message: "metadata is server-only" });
}
