export type StartupSelectionMode = "always" | "defaults" | "never";

export interface StartupSelectionPreferences {
	defaultAccountId: string | null;
	defaultNodeName: string | null;
	mode: StartupSelectionMode;
}

export interface StartupSelectionAccount {
	userId: string;
}

export interface StartupSelectionNode {
	name: string;
}

const MODE_KEY = "ryu_startup_selection_mode";
const DEFAULT_ACCOUNT_KEY = "ryu_startup_default_account";
const DEFAULT_NODE_KEY = "ryu_startup_default_node";

const VALID_MODES: StartupSelectionMode[] = ["always", "defaults", "never"];

function storage(): Storage | null {
	return globalThis.localStorage === undefined ? null : globalThis.localStorage;
}

function isMode(value: string | null): value is StartupSelectionMode {
	return value !== null && VALID_MODES.some((mode) => mode === value);
}

function notifyChanged(): void {
	if (globalThis.window !== undefined) {
		window.dispatchEvent(new Event("storage"));
	}
}

export function readStartupSelectionPreferences(): StartupSelectionPreferences {
	const store = storage();
	const mode = store?.getItem(MODE_KEY) ?? null;
	return {
		defaultAccountId: store?.getItem(DEFAULT_ACCOUNT_KEY) ?? null,
		defaultNodeName: store?.getItem(DEFAULT_NODE_KEY) ?? null,
		mode: isMode(mode) ? mode : "defaults",
	};
}

export function setStartupSelectionMode(mode: StartupSelectionMode): void {
	storage()?.setItem(MODE_KEY, mode);
	notifyChanged();
}

export function setStartupDefaultAccountId(userId: string | null): void {
	const store = storage();
	if (!store) {
		return;
	}
	if (userId) {
		store.setItem(DEFAULT_ACCOUNT_KEY, userId);
	} else {
		store.removeItem(DEFAULT_ACCOUNT_KEY);
	}
	notifyChanged();
}

export function setStartupDefaultNodeName(name: string | null): void {
	const store = storage();
	if (!store) {
		return;
	}
	if (name) {
		store.setItem(DEFAULT_NODE_KEY, name);
	} else {
		store.removeItem(DEFAULT_NODE_KEY);
	}
	notifyChanged();
}

/** The account applied during vault hydration when startup defaults are enabled. */
export function getStartupDefaultAccountId(): string | null {
	const preferences = readStartupSelectionPreferences();
	return preferences.mode === "defaults" ? preferences.defaultAccountId : null;
}

export function startupSelectionSteps({
	accounts,
	defaultAccountId,
	defaultNodeName,
	mode,
	nodes,
}: {
	accounts: readonly StartupSelectionAccount[];
	defaultAccountId: string | null;
	defaultNodeName: string | null;
	mode: StartupSelectionMode;
	nodes: readonly StartupSelectionNode[];
}) {
	if (mode === "never") {
		return { account: false, node: false };
	}

	if (mode === "always") {
		return { account: accounts.length > 0, node: nodes.length > 0 };
	}

	const accountDefaultMissing =
		accounts.length > 1 &&
		!(
			defaultAccountId &&
			accounts.some((account) => account.userId === defaultAccountId)
		);
	const nodeDefaultMissing =
		nodes.length > 1 &&
		!(defaultNodeName && nodes.some((node) => node.name === defaultNodeName));

	return { account: accountDefaultMissing, node: nodeDefaultMissing };
}
