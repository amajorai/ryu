import {
	createDpopReplayStore,
	type DpopReplayReservations,
	type DpopReplayStore,
} from "better-auth/oauth2";

/**
 * RFC 9449 (DPoP) verification of the configured Better Auth OAuth provider,
 * for Ryu's own protected resources: the hosted MCP endpoint and the node
 * delegation exchange. The provider's userinfo endpoint enforces sender
 * constraints with the same helpers, and its protected-resource metadata
 * advertises `DPOP_SIGNING_ALGORITHMS`.
 */
export {
	DPOP_SIGNING_ALGORITHMS,
	type DpopReplayStore,
	enforceDpopBinding,
	isDpopBindingError,
} from "better-auth/oauth2";

/**
 * How long a proof's reservation outlives the window in which the proof is
 * accepted. Better Auth 1.7.1 accepts a proof while `floor(now) - iat` is at
 * most the maximum age, so until one second after `iat + maxAge`, but reserves
 * it only until `iat + maxAge`; every verification lookup deletes expired
 * rows, so a proof accepted in its last second could be accepted again. The
 * margin also covers clock skew between server instances.
 */
export const DPOP_RESERVATION_MARGIN_MS = 60_000;

/**
 * Better Auth's database-backed replay store, with each reservation kept
 * `DPOP_RESERVATION_MARGIN_MS` past the end of the proof's acceptance window.
 */
export function createDpopReplayStoreOutlivingWindow(
	reservations: DpopReplayReservations
): DpopReplayStore {
	const store = createDpopReplayStore(reservations);
	return {
		reserve: (reservation) =>
			store.reserve({
				...reservation,
				expiresAt: new Date(
					reservation.expiresAt.getTime() + DPOP_RESERVATION_MARGIN_MS
				),
			}),
	};
}

/**
 * The provider's proof replay store: a single-use reservation per proof in
 * Better Auth's verification table, so a proof is accepted once across every
 * server instance (the table the provider's userinfo endpoint reserves in),
 * kept past the proof's acceptance window.
 */
export async function createProviderDpopReplayStore(): Promise<DpopReplayStore> {
	const { auth } = await import("../index.ts");
	return createDpopReplayStoreOutlivingWindow(
		(await auth.$context).internalAdapter
	);
}
