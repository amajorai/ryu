// Who is calling, for shared nodes.
//
// A Core node shared with an organization or team decides per member what each
// request may see, so island requests carry the signed-in user's short-lived JWT
// (`x-ryu-user-jwt`). The island holds no cloud session: the LOCAL Core does, and
// mints the JWT for local clients at `GET /api/auth/user-jwt`. The island then
// presents it to whichever Core it is pointed at, local or remote.

import {
	isLocalCoreUrl,
	resolveLocalNodeToken,
} from "@ryuhq/core-client/node-token";
import {
	coreBrokeredUserJwtExchange,
	createUserJwtSource,
	type UserJwtSource,
} from "@ryuhq/core-client/user-jwt";

/** Refresh cadence; the source only exchanges near the token's expiry. */
const REFRESH_INTERVAL_MS = 60_000;

/** The local Core that brokers the JWT for a configured Core target. The node
 * bearer of a remote target is never sent to the broker. */
interface IslandIdentityTarget {
	coreBaseUrl: string;
	coreToken: string | null;
	defaultCoreBaseUrl: string;
}
interface IslandIdentityBroker {
	token: string | null;
	url: string;
}
export function identityBrokerFor(
	input: IslandIdentityTarget
): IslandIdentityBroker {
	if (isLocalCoreUrl(input.coreBaseUrl)) {
		return { token: input.coreToken, url: input.coreBaseUrl };
	}
	return {
		token: resolveLocalNodeToken(input.defaultCoreBaseUrl),
		url: input.defaultCoreBaseUrl,
	};
}

let source: UserJwtSource | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Start (or restart after a settings change) the identity source. */
export function startIslandIdentity(broker: IslandIdentityBroker): void {
	source = createUserJwtSource({
		exchange: coreBrokeredUserJwtExchange(broker),
	});
	const active = source;
	active.refresh().catch(() => undefined);
	if (timer) {
		clearInterval(timer);
	}
	timer = setInterval(() => {
		active.refresh().catch(() => undefined);
	}, REFRESH_INTERVAL_MS);
	timer.unref?.();
}

/** The cached user JWT, or `null` when signed out or not yet fetched. */
export function currentIslandUserJwt(): string | null {
	return source?.current() ?? null;
}
