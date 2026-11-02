/** What the startup chooser commits when the user opens Ryu. */
export interface StartupChoices {
	/** The account picked, when the account step ran and it is not already active. */
	accountToActivate: string | null;
	/** Remembered account default: undefined leaves it untouched (step skipped). */
	defaultAccountId?: string | null;
	/** Remembered node default: undefined leaves it untouched (step skipped). */
	defaultNodeName?: string | null;
	nodeName: string;
}

export interface StartupChoiceWriters {
	saveDefaultNode: (name: string) => Promise<void>;
	setStartupDefaultAccountId: (userId: string | null) => void;
	setStartupDefaultNodeName: (name: string | null) => void;
	/** The desktop's switch is async; the extension's (through its desktop alias) is synchronous. */
	switchAccount: (userId: string) => Promise<unknown> | unknown;
}

/**
 * Commit the chooser's picks, the account switch last. Switching accounts
 * changes the settings owner, and the window reloads as soon as that write
 * settles (settings-sync/owner-reload.ts). Done first, it would reload over a
 * native node save still in flight, so a failed save never reached the
 * chooser's error and the account had already changed. Done last, a failed
 * node save rejects before anything is committed and the chooser can say so.
 */
export async function saveStartupChoices(
	choices: StartupChoices,
	writers: StartupChoiceWriters
): Promise<void> {
	await writers.saveDefaultNode(choices.nodeName);
	if (choices.defaultAccountId !== undefined) {
		writers.setStartupDefaultAccountId(choices.defaultAccountId);
	}
	if (choices.defaultNodeName !== undefined) {
		writers.setStartupDefaultNodeName(choices.defaultNodeName);
	}
	if (choices.accountToActivate) {
		await writers.switchAccount(choices.accountToActivate);
	}
}
