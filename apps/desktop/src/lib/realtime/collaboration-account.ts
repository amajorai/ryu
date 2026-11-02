// Which account collaborative snapshots are stored under, for both entry points
// that run the desktop tree (the desktop app and the web app).
//
// Snapshots are stored per account. On sign-out or an account switch, the
// previous account's synced snapshots are cleared; ones holding edits Core
// never received are kept (sealed, never shown to the next account) and the
// user is told, instead of losing them silently.

import { translate as tl } from "@ryu/i18n/core";
import { toast } from "@ryu/ui/components/sileo.tsx";

import {
	migrateLegacyYjsSnapshots,
	setCollaborationAccount,
} from "./yjs-persistence.ts";
import { releaseCollaborationAccount } from "./yjs-provider.ts";

/** The parts of the auth client this needs (injected for tests). */
export interface CollaborationAuth {
	/**
	 * The active account's id for keying local data: null when signed out, and
	 * also null while the active account is a placeholder whose userId is the
	 * bearer token (an offline sign-in or legacy install, not yet enriched).
	 */
	getActiveCollaborationAccountId(): string | null;
	onActiveTokenChange(listener: () => void): unknown;
	vaultHydrated: Promise<unknown>;
}

export function reportKeptCollaborationEdits(kept: number): void {
	// Raised from an auth callback, often before any component mounts, so it
	// translates through the active runtime rather than a hook.
	toast.warning(
		tl(
			"{count, plural, one {# document has local edits that were not synced. It was kept on this device, encrypted, and will sync when you sign back in to that account.} other {# documents have local edits that were not synced. They were kept on this device, encrypted, and will sync when you sign back in to that account.}}",
			{ count: kept }
		)
	);
}

/**
 * Set the collaboration account from the signed-in session (resolves once it
 * is set, so run it before the first render), seal the legacy plaintext
 * snapshots under it, and follow sign-out and account switches.
 *
 * The legacy sweep waits for a real account: with nobody signed in it would
 * seal every legacy snapshot under "anonymous", where no account ever reads
 * it. A placeholder account (its id is the bearer token) is "not known yet",
 * never an account: the token must not become a storage key.
 */
export async function followCollaborationAccount(
	auth: CollaborationAuth,
	reportKept: (kept: number) => void = reportKeptCollaborationEdits
): Promise<void> {
	await auth.vaultHydrated;
	let account = auth.getActiveCollaborationAccountId();
	let swept = false;
	const sweepFor = (id: string | null) => {
		if (id === null || swept) {
			return;
		}
		swept = true;
		migrateLegacyYjsSnapshots(id).catch(() => undefined);
	};
	setCollaborationAccount(account);
	sweepFor(account);
	auth.onActiveTokenChange(() => {
		const next = auth.getActiveCollaborationAccountId();
		if (next === account) {
			// Still unknown (signed out or a placeholder), or unchanged.
			return;
		}
		const previous = account;
		account = next;
		setCollaborationAccount(next);
		sweepFor(next);
		releaseCollaborationAccount(previous)
			.then(({ kept }) => {
				// Nothing was kept "for an account" when there was no account yet.
				if (kept > 0 && previous !== null) {
					reportKept(kept);
				}
			})
			.catch(() => undefined);
	});
}
