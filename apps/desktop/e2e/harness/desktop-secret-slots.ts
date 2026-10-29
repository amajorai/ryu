// The desktop's sealed secret slots (`desktop_secret_*`, src-tauri/src/secrets.rs).
// The native commands seal each value with a key held in the OS keychain; a
// browser fixture only models the slot boundary: the closed slot set, `null`
// for an empty slot, and a record that survives reload. The auth client
// (lib/auth-client.ts) reads `auth-vault` and EntitlementProvider reads
// `license-key` while their modules load, and the auth client subscribes to
// `desktop-secret-changed` to follow other windows.
//
// An empty slot answers `null`, so a plaintext vault a harness seeded in
// localStorage (or the legacy `auth.bin` store) is migrated into the slot on
// first load, exactly as an upgraded install does, and read from the slot after.

export const DESKTOP_SECRET_SLOTS = ["auth-vault", "license-key"] as const;
export const DESKTOP_SECRET_CHANGED_EVENT = "desktop-secret-changed";

/** The storage key a fixture keeps its slot record under. */
export const DESKTOP_SECRET_RECORD_KEY = "desktop-secret-slots";

type SlotName = (typeof DESKTOP_SECRET_SLOTS)[number];

export interface SlotStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export type SlotAnswer =
	| { handled: false; value: undefined }
	| { handled: true; value: unknown };

const NOT_HANDLED: SlotAnswer = { handled: false, value: undefined };

/** True for the native calls {@link answerDesktopSecretSlot} owns. */
export function isDesktopSecretCommand(
	command: string,
	args?: Record<string, unknown>
): boolean {
	return (
		command.startsWith("desktop_secret_") ||
		(command === "plugin:event|listen" &&
			args?.event === DESKTOP_SECRET_CHANGED_EVENT)
	);
}

function isSlotName(name: unknown): name is SlotName {
	return DESKTOP_SECRET_SLOTS.some((slot) => slot === name);
}

function readRecord(storage: SlotStorage): Partial<Record<SlotName, string>> {
	const raw = storage.getItem(DESKTOP_SECRET_RECORD_KEY);
	if (!raw) {
		return {};
	}
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object") {
		throw new Error("Corrupt secret slot fixture record");
	}
	const record: Partial<Record<SlotName, string>> = {};
	for (const [name, value] of Object.entries(parsed)) {
		if (isSlotName(name) && typeof value === "string") {
			record[name] = value;
		}
	}
	return record;
}

function exactKeys(args: Record<string, unknown>, expected: string[]): boolean {
	const keys = Object.keys(args).filter((key) => args[key] !== undefined);
	return (
		keys.length === expected.length &&
		keys.every((key) => expected.includes(key))
	);
}

/** A slot record held outside the page (Node side), surviving page reloads. */
export function memorySlotStorage(): SlotStorage {
	const record = new Map<string, string>();
	return {
		getItem: (key) => record.get(key) ?? null,
		setItem: (key, value) => {
			record.set(key, value);
		},
	};
}

export interface SealedAuthVaultAccount {
	token: string;
	userId: string;
}

export interface SealedAuthVault {
	accounts: SealedAuthVaultAccount[];
	/** The active account's bearer token, or null when signed out. */
	activeToken: string | null;
	activeUserId: string | null;
}

function isVaultAccount(value: unknown): value is SealedAuthVaultAccount {
	if (!value || typeof value !== "object") {
		return false;
	}
	const { userId, token } = value as Record<string, unknown>;
	return typeof userId === "string" && typeof token === "string";
}

/**
 * The `auth-vault` slot's vault, read from a fixture's raw slot record (the
 * value stored under {@link DESKTOP_SECRET_RECORD_KEY}). Null when the slot is
 * empty, which is how a signed-out (or never-migrated) vault reads.
 */
export function parseAuthVaultSlot(
	rawRecord: string | null
): SealedAuthVault | null {
	const raw = readRecord({
		getItem: () => rawRecord,
		setItem: () => undefined,
	})["auth-vault"];
	if (!raw) {
		return null;
	}
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object") {
		throw new Error("Corrupt auth-vault slot");
	}
	const { accounts, activeUserId } = parsed as Record<string, unknown>;
	if (!(Array.isArray(accounts) && accounts.every(isVaultAccount))) {
		throw new Error("Corrupt auth-vault slot accounts");
	}
	const active = typeof activeUserId === "string" ? activeUserId : null;
	return {
		accounts,
		activeUserId: active,
		activeToken:
			accounts.find((account) => account.userId === active)?.token ?? null,
	};
}

/** {@link parseAuthVaultSlot} over a fixture's slot storage. */
export function readAuthVaultSlot(
	storage: SlotStorage
): SealedAuthVault | null {
	return parseAuthVaultSlot(storage.getItem(DESKTOP_SECRET_RECORD_KEY));
}

/** The plaintext vault keys an older build kept in localStorage. */
export const LEGACY_VAULT_LOCAL_STORAGE_KEYS = [
	"ryu_accounts",
	"ryu_active_user_id",
	"ryu_session_token",
] as const;

let nextListener = 0;

/**
 * Answer a sealed-slot call. Unknown slot names and malformed arguments throw,
 * so a harness's strict native boundary still records them.
 */
export function answerDesktopSecretSlot(
	storage: SlotStorage,
	command: string,
	args: Record<string, unknown> = {}
): SlotAnswer {
	if (!isDesktopSecretCommand(command, args)) {
		return NOT_HANDLED;
	}
	if (command === "plugin:event|listen") {
		nextListener += 1;
		return { handled: true, value: 9000 + nextListener };
	}
	const name = args.name;
	if (!isSlotName(name)) {
		throw new Error(`Unknown secret slot: ${String(name)}`);
	}
	const record = readRecord(storage);
	if (command === "desktop_secret_get" && exactKeys(args, ["name"])) {
		return { handled: true, value: record[name] ?? null };
	}
	if (
		command === "desktop_secret_set" &&
		exactKeys(args, ["name", "value"]) &&
		typeof args.value === "string"
	) {
		record[name] = args.value;
		storage.setItem(DESKTOP_SECRET_RECORD_KEY, JSON.stringify(record));
		return { handled: true, value: null };
	}
	if (command === "desktop_secret_delete" && exactKeys(args, ["name"])) {
		delete record[name];
		storage.setItem(DESKTOP_SECRET_RECORD_KEY, JSON.stringify(record));
		return { handled: true, value: null };
	}
	throw new Error(`Invalid secret slot request: ${command}`);
}

const LEGACY_AUTH_STORE_RID = 7001;
const LEGACY_AUTH_STORE_KEYS = ["accounts", "activeUserId", "token"];

/**
 * An empty legacy `auth.bin` plugin store, for a harness that models no Tauri
 * store of its own. With an empty `auth-vault` slot the auth client probes it
 * once to migrate an older install, and purges it after; nothing is in it.
 */
export function answerEmptyLegacyAuthStore(
	command: string,
	args: Record<string, unknown> = {}
): SlotAnswer {
	if (command === "plugin:store|load" && args.path === "auth.bin") {
		return { handled: true, value: LEGACY_AUTH_STORE_RID };
	}
	const ownsKey =
		args.rid === LEGACY_AUTH_STORE_RID &&
		typeof args.key === "string" &&
		LEGACY_AUTH_STORE_KEYS.includes(args.key);
	if (command === "plugin:store|get" && ownsKey) {
		return { handled: true, value: [null, false] };
	}
	if (command === "plugin:store|delete" && ownsKey) {
		return { handled: true, value: false };
	}
	return NOT_HANDLED;
}
