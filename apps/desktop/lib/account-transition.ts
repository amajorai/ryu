export interface AccountIdentity {
	token: string | null;
	userId: string | null;
}

export interface AccountIdentityTransition {
	from: AccountIdentity;
	to: AccountIdentity;
}

const beforeIdentityChange = new Set<
	(transition: AccountIdentityTransition) => void
>();

export function onBeforeAccountIdentityChange(
	listener: (transition: AccountIdentityTransition) => void
): () => void {
	beforeIdentityChange.add(listener);
	return () => beforeIdentityChange.delete(listener);
}

export function announceAccountIdentityChange(
	transition: AccountIdentityTransition
): void {
	for (const listener of beforeIdentityChange) {
		listener(transition);
	}
}

// Account writes that continue after the synchronous announcement: the vault's
// durable copy (Tauri's `auth.bin`) and Core's logout. A window that reloads
// because the account changed waits for these first; reloading mid-write would
// leave the durable vault naming the previous account.
const inFlightAccountWrites = new Set<Promise<unknown>>();

/** Register an account write that the announcement started; returns it. */
export function trackAccountWrite<T>(write: Promise<T>): Promise<T> {
	inFlightAccountWrites.add(write);
	const settle = () => {
		inFlightAccountWrites.delete(write);
	};
	write.then(settle, settle);
	return write;
}

/** Resolves once no account write is in flight, including ones started while
 *  waiting. Never rejects. */
export async function accountWritesSettled(): Promise<void> {
	while (inFlightAccountWrites.size > 0) {
		await Promise.allSettled([...inFlightAccountWrites]);
	}
}

/** Fired on `window` after an account's browser-held state was deleted. */
export const ACCOUNT_STATE_REMOVED_EVENT = "ryu:account-state-removed";

/**
 * Tell in-memory caches that an account's browser-held state (its node bearers,
 * settings scope) was removed: one account's (`userId`) or every account's
 * (`null`). The storage keys are gone; this retires what a tab still holds.
 */
export function announceAccountStateRemoved(userId: string | null): void {
	if (!("window" in globalThis && "CustomEvent" in globalThis)) {
		return;
	}
	try {
		window.dispatchEvent(
			new CustomEvent(ACCOUNT_STATE_REMOVED_EVENT, { detail: { userId } })
		);
	} catch {
		// A listener throwing must not fail the sign-out.
	}
}
