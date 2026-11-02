import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";

// Shared host client, seeding, and per-test ledger hooks for the
// settings-sync-engine-native-http.*.spec.ts suites.

export const HOST = "http://127.0.0.1:5607";
export const control = { Authorization: "Bearer owned-proof-control" };
export interface Entry {
	deleted?: boolean;
	key: string;
	updatedAt: number;
	value: string | null;
}
export interface Receipt {
	calls: {
		id: number;
		method: string;
		path: string;
		authorization: string | null;
		body: unknown;
		settled: boolean;
		response?: unknown;
	}[];
	pending: number[];
	state: {
		accounts: Record<
			string,
			{ entries: Entry[]; revision: number; updatedAt: number }
		>;
		shortcuts: string;
		otherShortcuts: string;
	};
	unexpected: string[];
}
export async function read(request: APIRequestContext): Promise<Receipt> {
	const r = await request.get(`${HOST}/proof/state`, { headers: control });
	expect(r.status()).toBe(200);
	return r.json();
}
export async function action(
	request: APIRequestContext,
	name: string,
	data: unknown = {}
) {
	const r = await request.post(`${HOST}/proof/${name}`, {
		headers: control,
		data,
	});
	expect(r.status()).toBe(200);
}
export async function shortcutKey(page: Page) {
	const ua = await page.evaluate(() => navigator.userAgent);
	return `keybindings:${ua.includes("Mac") ? "darwin" : ua.includes("Windows") ? "win32" : "linux"}`;
}
export async function seed(
	page: Page,
	request: APIRequestContext,
	options: {
		remote?: Entry[];
		local?: Record<string, string>;
		meta?: Record<string, number>;
		policy?: string;
		cursor?: number;
		holdPull?: boolean;
		holdPushAck?: boolean;
		preserveOnReload?: boolean;
		expectedShortcutKey?: string;
		refuseShortcut?: boolean;
		refuseDelete?: boolean;
		shortcuts?: string;
		/** The vault account active at start (default A). */
		activeSlot?: "A" | "B";
		/**
		 * A store from before settings were scoped to accounts: no
		 * visible-owner record. By default the seeded state is the active
		 * account's own, as on any store this build wrote.
		 */
		preScoping?: boolean;
	} = {}
) {
	const remote = options.remote ?? [];
	const activeSlot = options.activeSlot ?? "A";
	await action(request, "reset", {
		// Both saved accounts, sealed in the desktop's `auth-vault` slot as a
		// current install keeps them (the auth client holds the active one in
		// memory; nothing of the vault is in localStorage).
		vault: {
			accounts: ["A", "B"].map((slot) => ({
				userId: `owned-account-${slot}`,
				token: `account-${slot}`,
				email: `${slot}@example.invalid`,
				name: slot,
				image: null,
			})),
			activeUserId: `owned-account-${activeSlot}`,
		},
		state: {
			accounts: {
				A: {
					entries: remote,
					revision: remote.length ? 1 : 0,
					updatedAt: Math.max(0, ...remote.map((e) => e.updatedAt)),
				},
				B: { entries: [], revision: 0, updatedAt: 0 },
			},
			shortcuts: options.shortcuts ?? "{}",
			otherShortcuts: options.shortcuts ?? "{}",
		},
		holdPull: options.holdPull,
		holdPushAck: options.holdPushAck,
		refuseShortcut: options.refuseShortcut,
		refuseDelete: options.refuseDelete,
	});
	await page.addInitScript(
		({ options }) => {
			if (
				options.preserveOnReload &&
				sessionStorage.getItem("owned-sync-seed-complete") === "true"
			) {
				return;
			}
			if (options.preserveOnReload) {
				sessionStorage.setItem("owned-sync-seed-complete", "true");
			}
			localStorage.clear();
			const activeSlot = options.activeSlot ?? "A";
			if (!options.preScoping) {
				localStorage.setItem(
					"ryu:settings-sync-visible-owner",
					`owned-account-${activeSlot}`
				);
			}
			localStorage.setItem("ryu:settings-sync-enabled", "true");
			localStorage.setItem("ryu:settings-sync-policy", options.policy ?? "ask");
			localStorage.setItem(
				"ryu:settings-sync-cursor",
				String(options.cursor ?? 0)
			);
			localStorage.setItem(
				"ryu:settings-sync-meta",
				JSON.stringify(options.meta ?? {})
			);
			for (const [k, v] of Object.entries(options.local ?? {})) {
				localStorage.setItem(k, v);
			}
		},
		{ options }
	);
	await page.goto("/settings-sync-engine-proof.html");
	if (options.expectedShortcutKey) {
		expect(
			await page.evaluate(() =>
				Reflect.get(window, "__syncProof").shortcutKey()
			)
		).toBe(options.expectedShortcutKey);
	} else {
		for (const entry of remote.filter((entry) =>
			entry.key.startsWith("keybindings:")
		)) {
			expect(
				await page.evaluate(() =>
					Reflect.get(window, "__syncProof").shortcutKey()
				)
			).toBe(entry.key);
		}
	}
	// 99500215a7 dropped the section title that repeated the pane title.
	await expect(
		page.getByText("Sync My Settings Across Machines", { exact: true })
	).toBeVisible();
}
/**
 * Account A's own shortcut set, as the engine holds one it captured from A's
 * edits. A pending stamp with no such capture (a node-wide set an earlier
 * build cached) is dropped rather than offered as A's, so it is no conflict.
 */
export function ownShortcutEdit(
	key: string,
	value: string
): Record<string, string> {
	return {
		"ryu:settings-sync-value-cache": JSON.stringify({ [key]: value }),
		"ryu:settings-sync-keybindings-capture:owned-account-A": "2",
	};
}
export async function pullCount(page: Page) {
	return page.evaluate(
		() =>
			Reflect.get(window, "__syncProof").consumed.filter((c: { url: string }) =>
				c.url.includes("/pull?")
			).length
	);
}
export async function settled(page: Page, before = 0) {
	await expect.poll(() => pullCount(page)).toBeGreaterThan(before);
	await expect
		.poll(() =>
			page.evaluate(() => Reflect.get(window, "__syncProof").status())
		)
		.not.toBe("syncing");
}
/**
 * The active account's bearer, read where the auth client keeps it: its
 * in-memory vault (the sealed `auth-vault` slot persists it). The account
 * switch no longer touches localStorage `ryu_session_token`.
 */
export async function activeToken(page: Page) {
	return page.evaluate(() => Reflect.get(window, "__syncProof").activeToken());
}
/** The active bearer the sealed `auth-vault` slot holds (shared by every window). */
export async function sealedActiveToken(page: Page) {
	return page.evaluate(() =>
		Reflect.get(window, "__nativeSecretProof").sealedActiveToken()
	);
}
export async function local(page: Page, key: string) {
	return page.evaluate((key) => localStorage.getItem(key), key);
}
export async function held(request: APIRequestContext) {
	let receipt: Receipt;
	await expect
		.poll(async () => {
			receipt = await read(request);
			return receipt.pending.length;
		})
		.toBe(1);
	return (await read(request)).pending[0]!;
}
export async function release(
	page: Page,
	request: APIRequestContext,
	id: number
) {
	await action(request, "release", { id });
	await expect
		.poll(async () => {
			const c = (await read(request)).calls.find((c) => c.id === id);
			return c?.settled;
		})
		.toBe(true);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					Reflect.get(window, "__syncProof").consumed.filter(
						(c: { url: string }) => c.url.includes("/pull?")
					).length
			)
		)
		.toBeGreaterThan(0);
	await settled(page);
}

/** Registers the per-test runtime-error capture and exact HTTP ledger audit. */
export function registerNativeHttpLedgerHooks(): void {
	let runtimeErrors: string[] = [];
	test.beforeEach(async ({ page }) => {
		runtimeErrors = [];
		page.on("pageerror", (e) => runtimeErrors.push(e.message));
	});
	test.afterEach(async ({ page, request }, info) => {
		// Invoke genuine cleanup before closing, so a still-pending failed draft
		// cannot emit a pagehide flush after its ledger or into the next test reset.
		const stop = page.getByRole("button", {
			name: "Stop settings engine",
			exact: true,
		});
		if (!page.isClosed() && (await stop.count())) {
			await stop.click();
		}
		// A test that failed while it held a response would leave it held, and
		// every later test's reset would then be refused. Release it so only the
		// failing test reports; a passing test must still leave nothing held.
		if (info.status !== info.expectedStatus) {
			for (const id of (await read(request)).pending) {
				await action(request, "release", { id });
			}
		}
		if (!page.isClosed()) {
			expect(
				await page.evaluate(() =>
					Reflect.get(window, "__nativeSecretProof").undeclared()
				)
			).toEqual([]);
		}
		await expect
			.poll(async () => {
				const receipt = await read(request);
				return {
					pending: receipt.pending,
					allSettled: receipt.calls.every((c) => c.settled),
				};
			})
			.toEqual({ pending: [], allSettled: true });
		await page.close();
		const receipt = await read(request);
		await info.attach("exact-native-http-ledger", {
			body: JSON.stringify(receipt, null, 2),
			contentType: "application/json",
		});
		expect(receipt.pending).toEqual([]);
		expect(receipt.calls.every((c) => c.settled)).toBe(true);
		expect(receipt.unexpected).toEqual([]);
		expect(runtimeErrors).toEqual([]);
	});
}
