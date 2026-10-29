// Who is calling, for shared nodes.
//
// A Core node shared with an organization or team decides per member what each
// request may see, so every request must carry the signed-in user's short-lived
// JWT (`x-ryu-user-jwt`). The CLI holds no cloud session of its own: the LOCAL
// Core does (`ryu login` signs it in), and it mints the JWT for local clients at
// `GET /api/auth/user-jwt`. The CLI then presents that JWT to whichever node it
// targets, local or remote.
//
// RYU_IDENTITY_CORE_URL   - local Core that brokers the JWT when the target is
//                           remote (default: the local Core for this profile)
// RYU_IDENTITY_CORE_TOKEN - that local Core's bearer, when it differs from the
//                           target's. Without it, a broker on this machine gets
//                           RYU_TOKEN, else the token Core minted in its data
//                           directory (secrets/node-auth.token); a broker that
//                           is not on this machine gets neither.

import { type ApiTarget, setUserJwtProvider } from "@ryuhq/core-client/client";
import {
	isLocalCoreUrl,
	readMintedNodeToken,
} from "@ryuhq/core-client/node-token";
import {
	coreBrokeredUserJwtExchange,
	createUserJwtSource,
	isLoopbackCoreUrl,
	type UserJwtSource,
} from "@ryuhq/core-client/user-jwt";
import { withCoreIdentityCheck } from "./coreIdentity.ts";
import { DEFAULT_CORE_URL } from "./target.ts";

/** Refresh cadence for long-lived TUI sessions; the source only exchanges
 * when its cached token is inside the refresh margin. */
const REFRESH_INTERVAL_MS = 60_000;

interface InstalledIdentity {
	refreshGeneration: number;
	source: UserJwtSource;
	timer: ReturnType<typeof setInterval> | null;
}

let installedIdentity: InstalledIdentity | null = null;
/**
 * `version` bumps on every publish, including the keep-fresh timer's retries.
 * `accountGeneration` bumps only when the signed-in account may have changed:
 * install, dispose, and each announced sign-in, switch or sign-out.
 */
let identitySnapshot = { accountGeneration: 0, refreshing: false, version: 0 };
const identityListeners = new Set<() => void>();

function publishIdentity(refreshing: boolean, accountChanged: boolean): void {
	identitySnapshot = {
		accountGeneration:
			identitySnapshot.accountGeneration + (accountChanged ? 1 : 0),
		refreshing,
		version: identitySnapshot.version + 1,
	};
	for (const listener of identityListeners) {
		listener();
	}
}

export function subscribeCliIdentity(listener: () => void): () => void {
	identityListeners.add(listener);
	return () => {
		identityListeners.delete(listener);
	};
}

export function getCliIdentitySnapshot(): Readonly<typeof identitySnapshot> {
	return identitySnapshot;
}

/** Release this CLI process's identity source and refresh timer. */
export function disposeCliIdentity(): void {
	const installed = installedIdentity;
	if (!installed) {
		return;
	}
	installed.source.clear();
	if (installed.timer) {
		clearInterval(installed.timer);
	}
	installedIdentity = null;
	setUserJwtProvider(() => null);
	publishIdentity(false, true);
}

/** Revoke the previous account immediately, then ask the real local broker.
 * Failed account mutations must not call this. Shared-source generation fencing
 * prevents an obsolete in-flight exchange from restoring the old identity. */
export async function refreshCliIdentityAfterAccountChange(): Promise<void> {
	await refreshInstalledIdentity(true);
}

async function refreshInstalledIdentity(
	accountChanged: boolean
): Promise<void> {
	const installed = installedIdentity;
	if (!installed) {
		return;
	}
	const generation = ++installed.refreshGeneration;
	installed.source.clear();
	publishIdentity(true, accountChanged);
	await installed.source.refresh();
	if (
		installedIdentity === installed &&
		installed.refreshGeneration === generation
	) {
		publishIdentity(false, false);
	}
}

/**
 * This machine's own bearer for a broker at `url`: an operator-provisioned
 * `RYU_TOKEN`, else the token Core minted in its data directory. Both are sent
 * only to a broker on this machine. `RYU_CORE_TOKEN` is not consulted: it may
 * be a remote target's token.
 */
function brokerTokenOnThisMachine(
	url: string,
	env: Record<string, string | undefined>
): string | null {
	if (!isLocalCoreUrl(url)) {
		return null;
	}
	return env.RYU_TOKEN?.trim() || readMintedNodeToken(url, env);
}

/** The local Core that can mint the signed-in user's JWT for `target`. */
export function identityBrokerFor(
	target: ApiTarget,
	env: Record<string, string | undefined> = process.env
): Pick<ApiTarget, "token" | "url"> {
	const configuredUrl = env.RYU_IDENTITY_CORE_URL?.trim();
	const configuredToken = env.RYU_IDENTITY_CORE_TOKEN?.trim() || null;
	const targetIsLocal = isLoopbackCoreUrl(target.url);
	// Never hand a remote node's bearer to the local broker.
	const localToken = configuredToken ?? (targetIsLocal ? target.token : null);
	let broker = { token: localToken, url: DEFAULT_CORE_URL };
	if (configuredUrl) {
		broker = { token: localToken, url: configuredUrl };
	} else if (targetIsLocal) {
		broker = { token: target.token, url: target.url };
	}
	return {
		token: broker.token ?? brokerTokenOnThisMachine(broker.url, env),
		url: broker.url,
	};
}

/** Install the identity provider for every core-client request and warm it. */
export async function installCliIdentity(
	target: ApiTarget,
	options: { keepFresh?: boolean; refreshIntervalMs?: number } = {}
): Promise<UserJwtSource> {
	const source = createUserJwtSource({
		// The broker is a loopback Core: it gets the node bearer only after
		// proving it holds it.
		exchange: coreBrokeredUserJwtExchange(
			withCoreIdentityCheck(identityBrokerFor(target))
		),
	});
	installedIdentity?.source.clear();
	if (installedIdentity?.timer) {
		clearInterval(installedIdentity.timer);
	}
	const installed: InstalledIdentity = {
		source,
		refreshGeneration: 0,
		timer: null,
	};
	installedIdentity = installed;
	setUserJwtProvider(() =>
		installedIdentity === installed ? source.current() : null
	);
	await refreshCliIdentityAfterAccountChange();
	if (options.keepFresh && installedIdentity === installed) {
		// A retry for the same account, not an account change.
		installed.timer = setInterval(() => {
			if (
				installedIdentity === installed &&
				!identitySnapshot.refreshing &&
				!source.current()
			) {
				void refreshInstalledIdentity(false);
			}
		}, options.refreshIntervalMs ?? REFRESH_INTERVAL_MS);
		installed.timer.unref?.();
	}
	return source;
}
