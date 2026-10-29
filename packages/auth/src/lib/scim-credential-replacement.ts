import type { BetterAuthOptions } from "@better-auth/core";
import { runWithTransaction } from "@better-auth/core/context";
import { z } from "zod";

/**
 * Atomic replacement of a managed SCIM connection's bearer.
 *
 * `@better-auth/scim` only offers additive rotation: `rotateSCIMManagedCredential`
 * adds a new active credential next to every unexpired one (up to
 * `maxActiveCredentials`), so a superseded bearer would keep authenticating.
 * Ryu documents token generation as a replacement, so this runs the plugin's
 * own revoke and rotate operations inside ONE database transaction:
 *
 * - every live credential of the connection is revoked,
 * - the replacement is issued,
 * - the catalog is re-read and must hold exactly that one active credential.
 *
 * The plugin's mutations join the ambient Better Auth transaction through
 * `getCurrentAdapter`, so any failure (a revoke, the rotation, or the final
 * check) rolls everything back: the previous bearer keeps working and the new
 * one never existed. There is no window in which both are accepted after the
 * call returns, and no partial state in which neither is.
 *
 * Revoking before rotating also lets a connection that accumulated the
 * plugin's maximum number of active credentials (the earlier additive
 * behavior) rotate again instead of failing with a full-slot conflict.
 */

type TransactionAdapter<Options extends BetterAuthOptions> = Parameters<
	typeof runWithTransaction<unknown, Options>
>[0];

interface ScimCredentialView {
	credentialId: string;
	expiresAt: Date;
	status: string;
}

interface ScimConnectionScope {
	connectionId: string;
	provisioningDomainId: string;
}

export interface ManagedScimReplacementApi<Rotation> {
	getSCIMManagedConnection(input: {
		body: ScimConnectionScope;
	}): Promise<{ credentials: ScimCredentialView[] }>;
	revokeSCIMManagedCredential(input: {
		body: ScimConnectionScope & { actorId: string; credentialId: string };
	}): Promise<unknown>;
	rotateSCIMManagedCredential(input: {
		body: ScimConnectionScope & {
			actorId: string;
			expiresAt: Date;
			scopes: readonly string[];
		};
	}): Promise<Rotation>;
}

const rotationResultSchema = z.object({
	credential: z.object({ credentialId: z.string().min(1) }),
});

function liveCredentials(
	credentials: readonly ScimCredentialView[],
	now: number
): ScimCredentialView[] {
	return credentials.filter(
		(candidate) =>
			candidate.status === "active" && candidate.expiresAt.getTime() > now
	);
}

/**
 * Better Auth's adapter factory substitutes a non-atomic pass-through when the
 * database adapter has no native transaction (for example a Mongo adapter
 * built without its client). Replacement must not silently degrade to that.
 */
function assertNativeTransactions<Options extends BetterAuthOptions>(
	adapter: TransactionAdapter<Options>
): void {
	if (typeof adapter.options?.adapterConfig.transaction === "function") {
		return;
	}
	throw new Error(
		"SCIM credential replacement requires a database adapter with native transactions"
	);
}

export async function replaceScimManagedCredential<
	Rotation,
	Options extends BetterAuthOptions,
>(input: {
	actorId: string;
	adapter: TransactionAdapter<Options>;
	api: ManagedScimReplacementApi<Rotation>;
	connectionId: string;
	expiresAt: Date;
	provisioningDomainId: string;
	scopes: readonly string[];
}): Promise<Rotation> {
	assertNativeTransactions(input.adapter);
	const scope: ScimConnectionScope = {
		connectionId: input.connectionId,
		provisioningDomainId: input.provisioningDomainId,
	};
	return await runWithTransaction(input.adapter, async () => {
		const before = await input.api.getSCIMManagedConnection({ body: scope });
		for (const superseded of liveCredentials(before.credentials, Date.now())) {
			await input.api.revokeSCIMManagedCredential({
				body: {
					...scope,
					actorId: input.actorId,
					credentialId: superseded.credentialId,
				},
			});
		}
		const rotation = await input.api.rotateSCIMManagedCredential({
			body: {
				...scope,
				actorId: input.actorId,
				expiresAt: input.expiresAt,
				scopes: input.scopes,
			},
		});
		const { credential } = rotationResultSchema.parse(rotation);
		const after = await input.api.getSCIMManagedConnection({ body: scope });
		const active = liveCredentials(after.credentials, Date.now());
		if (
			active.length !== 1 ||
			active[0]?.credentialId !== credential.credentialId
		) {
			throw new Error("SCIM credential replacement did not converge");
		}
		return rotation;
	});
}
