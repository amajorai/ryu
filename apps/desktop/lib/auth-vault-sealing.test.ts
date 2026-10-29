import { afterAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { TauriUnavailableError } from "@/src/lib/tauri-ready.ts";

// A stand-in for the native `desktop_secret_*` slot: what the Rust side seals
// into `secrets/desktop-auth-vault.sealed`. It records every command so the test
// can prove where the vault is (and is not) written.
GlobalRegistrator.register();
const slots = new Map<string, string>();
const commands: string[] = [];
let refuseReads = false;
/** How `desktop_secret_set` fails, to model a seal that cannot complete. */
let sealFailure: (() => Error) | null = null;
Reflect.set(window, "__TAURI_INTERNALS__", {
	invoke: (command: string, args: { name?: string; value?: string }) => {
		commands.push(command);
		if (command === "desktop_secret_get") {
			if (refuseReads) {
				return Promise.reject(
					new Error("A sealed desktop value could not be opened")
				);
			}
			return Promise.resolve(slots.get(args.name ?? "") ?? null);
		}
		if (command === "desktop_secret_set") {
			if (sealFailure) {
				return Promise.reject(sealFailure());
			}
			slots.set(args.name ?? "", args.value ?? "");
			return Promise.resolve(null);
		}
		if (command === "desktop_secret_delete") {
			slots.delete(args.name ?? "");
			return Promise.resolve(null);
		}
		// The legacy `auth.bin` plugin store and event plumbing: nothing stored.
		return Promise.resolve(null);
	},
	transformCallback: () => 0,
});

// A plaintext vault an older build left in localStorage.
const legacyAccount = {
	email: "ada@example.test",
	image: null,
	name: "Ada",
	token: "legacy-bearer-0123456789",
	userId: "user-ada",
};
localStorage.setItem("ryu_accounts", JSON.stringify([legacyAccount]));
localStorage.setItem("ryu_active_user_id", "user-ada");
localStorage.setItem("ryu_session_token", legacyAccount.token);

const fetchSpy = spyOn(globalThis, "fetch");
const client = await import("./auth-client.ts");
await client.vaultHydrated;

afterAll(() => {
	fetchSpy.mockRestore();
	GlobalRegistrator.unregister();
});

test("a plaintext localStorage vault is moved into the sealed slot and removed", () => {
	expect(client.getActiveToken()).toBe(legacyAccount.token);
	expect(JSON.parse(slots.get("auth-vault") ?? "null")).toEqual({
		accounts: [legacyAccount],
		activeUserId: "user-ada",
	});
	expect(localStorage.getItem("ryu_accounts")).toBeNull();
	expect(localStorage.getItem("ryu_active_user_id")).toBeNull();
	expect(localStorage.getItem("ryu_session_token")).toBeNull();
});

test("sign-in, switching and sign-out write only the sealed slot", async () => {
	fetchSpy.mockResolvedValue(
		Response.json({ user: { id: "user-lin", email: "lin@example.test" } })
	);
	const changes: Array<string | null> = [];
	const stop = client.onActiveTokenChange(() =>
		changes.push(client.getActiveToken())
	);
	await client.addAccount("lin-bearer-0123456789");
	expect(client.getActiveToken()).toBe("lin-bearer-0123456789");
	await client.switchAccount("user-ada");
	expect(changes).toEqual(["lin-bearer-0123456789", legacyAccount.token]);
	for (let index = 0; index < localStorage.length; index += 1) {
		const key = localStorage.key(index) ?? "";
		expect(localStorage.getItem(key)).not.toContain("bearer");
	}
	expect(
		JSON.parse(slots.get("auth-vault") ?? "null").accounts.map(
			(account: { userId: string }) => account.userId
		)
	).toEqual(["user-ada", "user-lin"]);
	await client.signOutAccount("user-lin");
	await client.signOutAccount("user-ada");
	expect(client.getActiveToken()).toBeNull();
	expect(slots.has("auth-vault")).toBe(false);
	expect(commands).toContain("desktop_secret_delete");
	stop();
});

test("a slot that cannot be opened leaves the app signed out instead of using a plaintext copy", async () => {
	slots.set("auth-vault", JSON.stringify({ accounts: [], activeUserId: null }));
	refuseReads = true;
	localStorage.setItem("ryu_session_token", "stale-plaintext-bearer");
	// A query string loads a second, independent copy of the module.
	const freshSpecifier = "./auth-client.ts?unopenable";
	const fresh: typeof import("./auth-client.ts") = await import(freshSpecifier);
	await fresh.vaultHydrated;
	expect(fresh.getActiveToken()).toBeNull();
	expect(fresh.listAccounts()).toEqual([]);
	refuseReads = false;
});

test("a vault that could not be read is never overwritten by a sign-in", async () => {
	slots.set(
		"auth-vault",
		JSON.stringify({ accounts: [legacyAccount], activeUserId: "user-ada" })
	);
	refuseReads = true;
	const lockedSpecifier = "./auth-client.ts?locked";
	const locked: typeof import("./auth-client.ts") = await import(
		lockedSpecifier
	);
	await locked.vaultHydrated;
	expect(locked.isVaultLocked()).toBe(true);
	// A fresh Response per call: a body can be read once.
	fetchSpy.mockImplementation((() =>
		Promise.resolve(
			Response.json({ user: { id: "user-lin", email: "lin@example.test" } })
		)) as unknown as typeof fetch);
	const sealedBefore = slots.get("auth-vault");
	await locked.addAccount("lin-bearer-0123456789");
	// Signed in for this session, but the unread slot is untouched.
	expect(locked.getActiveToken()).toBe("lin-bearer-0123456789");
	expect(slots.get("auth-vault")).toBe(sealedBefore);

	refuseReads = false;
	await locked.addAccount("lin-bearer-0123456789");
	expect(locked.isVaultLocked()).toBe(false);
	expect(
		JSON.parse(slots.get("auth-vault") ?? "null").accounts.map(
			(account: { userId: string }) => account.userId
		)
	).toEqual(["user-lin", "user-ada"]);
	slots.delete("auth-vault");
});

const LEGACY_VAULT_KEYS = [
	"ryu_accounts",
	"ryu_active_user_id",
	"ryu_session_token",
] as const;

function seedLegacyVault(): void {
	localStorage.setItem("ryu_accounts", JSON.stringify([legacyAccount]));
	localStorage.setItem("ryu_active_user_id", "user-ada");
	localStorage.setItem("ryu_session_token", legacyAccount.token);
}

function legacyVaultSnapshot(): Array<string | null> {
	return LEGACY_VAULT_KEYS.map((key) => localStorage.getItem(key));
}

for (const [label, failure, specifier] of [
	[
		"reports no secure store (the webapp shim's browser-seal failure)",
		() => new TauriUnavailableError("desktop_secret_set"),
		"./auth-client.ts?seal-unavailable",
	],
	[
		"rejects with a native seal error",
		() => new Error("The desktop seal key is unavailable"),
		"./auth-client.ts?seal-error",
	],
] as const) {
	test(`a migration whose sealed write ${label} keeps the plaintext vault for the next launch`, async () => {
		slots.clear();
		seedLegacyVault();
		const before = legacyVaultSnapshot();
		sealFailure = failure;
		try {
			const fresh: typeof import("./auth-client.ts") = await import(specifier);
			await fresh.vaultHydrated;
			expect(slots.has("auth-vault")).toBe(false);
			expect(legacyVaultSnapshot()).toEqual(before);
		} finally {
			sealFailure = null;
		}
		// The next launch retries the migration, and only a confirmed sealed
		// write removes the plaintext copy.
		const retrySpecifier = `${specifier}-retry`;
		const retry: typeof import("./auth-client.ts") = await import(
			retrySpecifier
		);
		await retry.vaultHydrated;
		expect(retry.getActiveToken()).toBe(legacyAccount.token);
		expect(JSON.parse(slots.get("auth-vault") ?? "null")).toEqual({
			accounts: [legacyAccount],
			activeUserId: "user-ada",
		});
		expect(legacyVaultSnapshot()).toEqual([null, null, null]);
	});
}
