import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";

const HOST = "http://127.0.0.1:5607";
const control = { Authorization: "Bearer owned-proof-control" };
interface Entry {
	deleted?: boolean;
	key: string;
	updatedAt: number;
	value: string | null;
}
interface Receipt {
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
async function read(request: APIRequestContext): Promise<Receipt> {
	const r = await request.get(`${HOST}/proof/state`, { headers: control });
	expect(r.status()).toBe(200);
	return r.json();
}
async function action(
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
async function shortcutKey(page: Page) {
	const ua = await page.evaluate(() => navigator.userAgent);
	return `keybindings:${ua.includes("Mac") ? "darwin" : ua.includes("Windows") ? "win32" : "linux"}`;
}
async function seed(
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
	await action(request, "reset", {
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
			localStorage.setItem("ryu_session_token", `account-${activeSlot}`);
			localStorage.setItem(
				"ryu_accounts",
				JSON.stringify(
					["A", "B"].map((slot) => ({
						userId: `owned-account-${slot}`,
						token: `account-${slot}`,
						email: `${slot}@example.invalid`,
						name: slot,
						image: null,
					}))
				)
			);
			localStorage.setItem("ryu_active_user_id", `owned-account-${activeSlot}`);
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
	await expect(
		page.getByRole("heading", { name: "Settings Sync", exact: true })
	).toBeVisible();
}
/**
 * Account A's own shortcut set, as the engine holds one it captured from A's
 * edits. A pending stamp with no such capture (a node-wide set an earlier
 * build cached) is dropped rather than offered as A's, so it is no conflict.
 */
function ownShortcutEdit(key: string, value: string): Record<string, string> {
	return {
		"ryu:settings-sync-value-cache": JSON.stringify({ [key]: value }),
		"ryu:settings-sync-keybindings-capture:owned-account-A": "2",
	};
}
async function pullCount(page: Page) {
	return page.evaluate(
		() =>
			Reflect.get(window, "__syncProof").consumed.filter((c: { url: string }) =>
				c.url.includes("/pull?")
			).length
	);
}
async function settled(page: Page, before = 0) {
	await expect.poll(() => pullCount(page)).toBeGreaterThan(before);
	await expect
		.poll(() =>
			page.evaluate(() => Reflect.get(window, "__syncProof").status())
		)
		.not.toBe("syncing");
}
async function local(page: Page, key: string) {
	return page.evaluate((key) => localStorage.getItem(key), key);
}
async function held(request: APIRequestContext) {
	let receipt: Receipt;
	await expect
		.poll(async () => {
			receipt = await read(request);
			return receipt.pending.length;
		})
		.toBe(1);
	return (await read(request)).pending[0]!;
}
async function release(page: Page, request: APIRequestContext, id: number) {
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

test("automatic download applies the newer cloud value without echoing an upload", async ({
	page,
	request,
}) => {
	await seed(page, request, {
		remote: [{ key: "theme", value: "light", updatedAt: 200 }],
		local: { theme: "dark" },
		meta: { theme: 100 },
		policy: "download",
	});
	await settled(page);
	expect(await local(page, "theme")).toBe("light");
	const receipt = await read(request);
	expect(receipt.calls.filter((c) => c.method === "POST")).toEqual([]);
	expect(receipt.state.accounts.A.entries).toEqual([
		{ key: "theme", value: "light", updatedAt: 200 },
	]);
	expect(await local(page, "ryu:settings-sync-cursor")).toBe("200");
	await expect(page.getByText("Up to date", { exact: true })).toBeVisible();
});
test("automatic keep-this-machine resolves the competing newer cloud value and persists the local copy", async ({
	page,
	request,
}) => {
	await seed(page, request, {
		remote: [{ key: "theme", value: "light", updatedAt: 200 }],
		local: { theme: "dark" },
		meta: { theme: 100 },
		policy: "upload",
	});
	await settled(page);
	expect(await local(page, "theme")).toBe("dark");
	const receipt = await read(request);
	expect(receipt.calls.filter((c) => c.method === "POST")).toHaveLength(1);
	expect(receipt.state.accounts.A.entries).toEqual([
		{
			key: "theme",
			value: "dark",
			updatedAt: expect.any(Number),
			deleted: false,
		},
	]);
	expect(receipt.state.accounts.A.entries[0]!.updatedAt).toBeGreaterThan(200);
	await expect(page.getByText("Up to date", { exact: true })).toBeVisible();
});
test("opting out while the pull is held prevents late cloud import and new outbound pushes", async ({
	page,
	request,
}) => {
	await seed(page, request, {
		remote: [{ key: "theme", value: "light", updatedAt: 200 }],
		local: { theme: "dark", ryu_ui_font: "Inter" },
		meta: { theme: 10, ryu_ui_font: 100 },
		cursor: 10,
		holdPull: true,
	});
	const id = await held(request);
	await page.getByRole("switch").click();
	await expect(page.getByRole("switch")).toHaveAttribute(
		"aria-checked",
		"false"
	);
	await release(page, request, id);
	expect(await local(page, "theme")).toBe("dark");
	expect(
		(await read(request)).calls.filter((c) => c.method === "POST")
	).toEqual([]);
	expect(await local(page, "ryu:settings-sync-cursor")).toBe("10");
	await page.getByRole("switch").click();
	await expect
		.poll(async () =>
			(await read(request)).state.accounts.A.entries.some(
				(e) => e.key === "ryu_ui_font" && e.value === "Inter"
			)
		)
		.toBe(true);
});
for (const aba of [false, true]) {
	test(`held account A pull cannot import or upload under ${aba ? "returned A epoch" : "account B authority"}`, async ({
		page,
		request,
	}) => {
		await seed(page, request, {
			remote: [{ key: "theme", value: "light", updatedAt: 200 }],
			local: { theme: "dark", ryu_ui_font: "Inter" },
			meta: { theme: 10, ryu_ui_font: 100 },
			cursor: 10,
			holdPull: true,
		});
		const id = await held(request);
		await page
			.getByRole("button", { name: "Switch to saved account B" })
			.click();
		await expect.poll(() => local(page, "ryu_session_token")).toBe("account-B");
		if (aba) {
			await page
				.getByRole("button", { name: "Switch to saved account A" })
				.click();
			await expect
				.poll(() => local(page, "ryu_session_token"))
				.toBe("account-A");
		}
		await release(page, request, id);
		expect(await local(page, "theme")).toBe(aba ? "dark" : null);
		const receipt = await read(request);
		expect(receipt.calls.filter((c) => c.method === "POST")).toEqual([]);
		expect(receipt.calls.filter((c) => c.path.includes("/pull?"))).toEqual([
			expect.objectContaining({
				authorization: "Bearer account-A",
				path: "/api/desktop-settings-sync/pull?since=10",
				settled: true,
			}),
		]);
		expect(receipt.state.accounts.A.entries).toEqual([
			{ key: "theme", value: "light", updatedAt: 200 },
		]);
		expect(receipt.state.accounts.B.entries).toEqual([]);
		expect(await local(page, "ryu:settings-sync-cursor")).not.toBe("200");
		{
			const before = receipt.calls.filter((c) =>
				c.path.includes("/pull?")
			).length;
			const consumedBefore = await pullCount(page);
			await page.getByRole("button", { name: "Sync now", exact: true }).click();
			await expect
				.poll(
					async () =>
						(await read(request)).calls.filter((c) => c.path.includes("/pull?"))
							.length
				)
				.toBe(before + 1);
			await settled(page, consumedBefore);
			const fresh = await read(request);
			expect(
				fresh.calls.filter((c) => c.path.includes("/pull?")).at(-1)
			).toMatchObject({
				authorization: aba ? "Bearer account-A" : "Bearer account-B",
				path: "/api/desktop-settings-sync/pull?since=0",
			});
			expect(
				fresh.state.accounts.B.entries.some((e) => e.value === "light")
			).toBe(false);
			// A's surviving dirty edit stays with A as well: B's cloud copy and
			// every request authorized as B are free of it.
			expect(
				fresh.state.accounts.B.entries.some((e) => e.value === "Inter")
			).toBe(false);
			expect(
				fresh.calls.some(
					(c) =>
						c.authorization === "Bearer account-B" &&
						JSON.stringify(c.body ?? null).includes("Inter")
				)
			).toBe(false);
			expect(await local(page, "theme")).toBe(aba ? "light" : null);
			expect(
				fresh.calls
					.filter((c) => c.method === "POST")
					.every(
						(c) =>
							c.authorization ===
							(aba ? "Bearer account-A" : "Bearer account-B")
					)
			).toBe(true);
		}
	});
}

test("account switch keeps a dirty sidebar value with its author for pagehide flush", async ({
	page,
	request,
}) => {
	const key = "ryu:bot-chat-sections:v1";
	const accountAValue = JSON.stringify([{ id: "private-a", title: "A only" }]);
	await seed(page, request);
	await settled(page);
	await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
		key,
		value: accountAValue,
	});
	await page.getByRole("button", { name: "Switch to saved account B" }).click();
	await expect.poll(() => local(page, "ryu_session_token")).toBe("account-B");
	expect(await local(page, key)).toBeNull();
	await page.evaluate(() =>
		window.dispatchEvent(new PageTransitionEvent("pagehide"))
	);
	await page.waitForTimeout(50);
	expect(
		(await read(request)).calls.filter((call) => call.method === "POST")
	).toEqual([]);

	await page.getByRole("button", { name: "Switch to saved account A" }).click();
	await expect.poll(() => local(page, "ryu_session_token")).toBe("account-A");
	expect(await local(page, key)).toBe(accountAValue);
	await page.evaluate(() =>
		window.dispatchEvent(new PageTransitionEvent("pagehide"))
	);
	await expect
		.poll(async () =>
			(await read(request)).calls.some(
				(call) =>
					call.method === "POST" &&
					call.authorization === "Bearer account-A" &&
					JSON.stringify(call.body).includes("private-a")
			)
		)
		.toBe(true);
	expect((await read(request)).state.accounts.B.entries).toEqual([]);
});

test("account switch keeps a dirty sidebar value with its author for a fresh sync cycle", async ({
	page,
	request,
}) => {
	const key = "ryu:bot-chat-sections:v1";
	const accountAValue = JSON.stringify([{ id: "private-a", title: "A only" }]);
	await seed(page, request);
	await settled(page);
	await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
		key,
		value: accountAValue,
	});
	await page.getByRole("button", { name: "Switch to saved account B" }).click();
	await expect.poll(() => local(page, "ryu_session_token")).toBe("account-B");
	expect(await local(page, key)).toBeNull();
	const beforeB = await pullCount(page);
	await page.getByRole("button", { name: "Sync now", exact: true }).click();
	await settled(page, beforeB);
	const afterB = await read(request);
	expect(
		afterB.calls.some(
			(call) =>
				call.authorization === "Bearer account-B" &&
				JSON.stringify(call.body ?? null).includes("private-a")
		)
	).toBe(false);
	expect(
		afterB.state.accounts.B.entries.some((entry) =>
			String(entry.value).includes("private-a")
		)
	).toBe(false);

	await page.getByRole("button", { name: "Switch to saved account A" }).click();
	await expect.poll(() => local(page, "ryu_session_token")).toBe("account-A");
	expect(await local(page, key)).toBe(accountAValue);
	const beforeA = await pullCount(page);
	await page.getByRole("button", { name: "Sync now", exact: true }).click();
	await settled(page, beforeA);
	await expect
		.poll(async () =>
			(await read(request)).state.accounts.A.entries.some(
				(entry) => entry.key === key && entry.value === accountAValue
			)
		)
		.toBe(true);
	const final = await read(request);
	expect(
		final.calls.some(
			(call) =>
				call.authorization === "Bearer account-B" &&
				JSON.stringify(call.body ?? null).includes("private-a")
		)
	).toBe(false);
	expect(final.state.accounts.B.entries).toEqual([]);
});

test("a pre-scoping store's pending sidebar value is not uploaded by the account active at upgrade", async ({
	page,
	request,
}) => {
	// An earlier build kept A's unsent sidebar edit, its stamp and the cursor
	// across a switch to B, with no record of whose they were.
	const key = "ryu:bot-chat-sections:v1";
	const accountAValue = JSON.stringify([{ id: "private-a", title: "A only" }]);
	await seed(page, request, {
		activeSlot: "B",
		cursor: 0,
		local: {
			[key]: accountAValue,
			"ryu:settings-sync-pending-local": JSON.stringify({ [key]: 100 }),
		},
		meta: { [key]: 100 },
		preScoping: true,
	});
	await settled(page);
	await page.evaluate(() =>
		window.dispatchEvent(new PageTransitionEvent("pagehide"))
	);
	const before = await pullCount(page);
	await page.getByRole("button", { name: "Sync now", exact: true }).click();
	await settled(page, before);
	const receipt = await read(request);
	expect(
		receipt.calls.some((call) =>
			JSON.stringify(call.body ?? null).includes("private-a")
		)
	).toBe(false);
	expect(receipt.state.accounts.B.entries).toEqual([]);
	// B read its own whole document instead of adopting the legacy cursor.
	expect(
		receipt.calls.some(
			(call) =>
				call.authorization === "Bearer account-B" &&
				call.path.includes("/pull") &&
				call.path.includes("since=0")
		)
	).toBe(true);
	expect(
		JSON.parse(
			(await local(page, "ryu:settings-sync-meta:owned-account-B")) ?? "{}"
		)
	).not.toHaveProperty(key);
});

test("a window left behind by another window's switch drops its stale sidebar write", async ({
	page,
	request,
}) => {
	const key = "ryu:bot-chat-sections:v1";
	const accountAValue = JSON.stringify([{ id: "private-a", title: "A only" }]);
	const accountBValue = JSON.stringify([{ id: "private-b", title: "B only" }]);
	await seed(page, request);
	await settled(page);
	// Another window has installed B's values and recorded B as their owner;
	// this window has processed none of it and a feature here writes A's
	// in-memory value back. The real same-document setItem patch runs here.
	const result = await page.evaluate(
		({ key, accountAValue, accountBValue }) => {
			const originalSet = Storage.prototype.setItem;
			originalSet.call(localStorage, key, accountBValue);
			localStorage.setItem(
				"ryu:settings-sync-visible-owner",
				"owned-account-B"
			);
			localStorage.setItem(key, accountAValue);
			const stale = localStorage.getItem(key);
			const meta = JSON.parse(
				localStorage.getItem("ryu:settings-sync-meta:owned-account-A") ?? "{}"
			);
			return { stale, stamped: key in meta };
		},
		{ key, accountAValue, accountBValue }
	);
	expect(result).toEqual({ stale: accountBValue, stamped: false });
	await page.evaluate(() =>
		window.dispatchEvent(new PageTransitionEvent("pagehide"))
	);
	await page.waitForTimeout(50);
	expect(
		(await read(request)).calls.some((call) =>
			JSON.stringify(call.body ?? null).includes("private-a")
		)
	).toBe(false);
});

test("a second window that followed another window's switch drops its in-memory write-back and is told to reload", async ({
	context,
	page,
	request,
}) => {
	const key = "ryu:bot-chat-sections:v1";
	const accountAValue = JSON.stringify([{ id: "private-a", title: "A only" }]);
	await seed(page, request, { local: { [key]: accountAValue } });
	await settled(page);
	// A second window of the app over the same storage, loaded while A's
	// sections are visible (its features hold them in memory).
	const second = await context.newPage();
	await second.addInitScript(() => {
		Reflect.set(window, "__ownerChanged", 0);
		window.addEventListener("ryu:settings-owner-changed", () => {
			Reflect.set(
				window,
				"__ownerChanged",
				Reflect.get(window, "__ownerChanged") + 1
			);
		});
	});
	await second.goto("/settings-sync-engine-proof.html");
	await settled(second);
	expect(await local(second, key)).toBe(accountAValue);

	// The switch happens in the first window; the second follows it through
	// real storage events.
	await page.getByRole("button", { name: "Switch to saved account B" }).click();
	await expect.poll(() => local(second, "ryu_session_token")).toBe("account-B");
	await expect.poll(() => local(second, key)).toBeNull();

	// A feature in the second window writes its in-memory (A's) value back
	// through the real same-document setItem patch.
	const written = await second.evaluate(
		({ key, accountAValue }) => {
			localStorage.setItem(key, accountAValue);
			return localStorage.getItem(key);
		},
		{ key, accountAValue }
	);
	expect(written).toBeNull();
	await second.evaluate(() =>
		window.dispatchEvent(new PageTransitionEvent("pagehide"))
	);
	const before = await pullCount(second);
	await second.getByRole("button", { name: "Sync now", exact: true }).click();
	await settled(second, before);
	const receipt = await read(request);
	expect(
		receipt.calls.some(
			(call) =>
				call.authorization === "Bearer account-B" &&
				JSON.stringify(call.body ?? null).includes("private-a")
		)
	).toBe(false);
	expect(receipt.state.accounts.B.entries).toEqual([]);
	// The second window was told to reload (the app reloads it on this event).
	expect(
		await second.evaluate(() => Reflect.get(window, "__ownerChanged"))
	).toBe(1);
	await second.close();
});

test("refused Core shortcut download preserves durable bindings and retries the exact remote value", async ({
	page,
	request,
}) => {
	const old = JSON.stringify({ "chat.send": "Enter" });
	const next = JSON.stringify({ "chat.send": "Mod+Enter" });
	const key = await shortcutKey(page);
	// Seed the actual browser slot and verify the shipping helper agrees.
	await seed(page, request, {
		remote: [{ key, value: next, updatedAt: 200 }],
		meta: { [key]: 10 },
		cursor: 10,
		refuseShortcut: true,
		shortcuts: old,
	});
	await settled(page);
	let receipt = await read(request);
	expect(
		receipt.calls.filter((c) => c.method === "PUT").map((c) => c.body)
	).toEqual([{ value: next }]);
	expect(receipt.state.shortcuts).toBe(old);
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "__syncProof").readShortcuts()
		)
	).toEqual(JSON.parse(old));
	expect(
		JSON.parse((await local(page, "ryu:settings-sync-value-cache")) ?? "{}")[
			key
		]
	).not.toBe(next);
	expect(await local(page, "ryu:settings-sync-cursor")).toBe("10");
	await expect(page.getByText("Up to date", { exact: true })).toHaveCount(0);
	await action(request, "allow-shortcut");
	const retryPulls = await pullCount(page);
	await page.getByRole("button", { name: "Sync now", exact: true }).click();
	await settled(page, retryPulls);
	receipt = await read(request);
	expect(receipt.state.shortcuts).toBe(next);
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "__syncProof").readShortcuts()
		)
	).toEqual(JSON.parse(next));
	expect(
		receipt.calls.filter((c) => c.method === "PUT").map((c) => c.body)
	).toEqual([{ value: next }, { value: next }]);
	expect(await local(page, "ryu:settings-sync-cursor")).toBe("200");
	await page.reload();
	await settled(page);
	expect((await read(request)).state.shortcuts).toBe(next);
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "__syncProof").readShortcuts()
		)
	).toEqual(JSON.parse(next));
});
test("cloud-copy delete refusal preserves the remote document and accepted retry leaves a fresh pull empty", async ({
	page,
	request,
}) => {
	await seed(page, request, {
		remote: [{ key: "theme", value: "dark", updatedAt: 200 }],
		local: { theme: "dark" },
		meta: { theme: 200 },
		cursor: 200,
		refuseDelete: true,
	});
	await settled(page);
	await page
		.getByRole("button", { name: "Delete cloud copy", exact: true })
		.click();
	const dialog = page.getByRole("alertdialog");
	await dialog
		.getByRole("button", { name: "Delete cloud copy", exact: true })
		.click();
	await expect(
		page.getByText("Couldn't delete the cloud copy", { exact: true })
	).toBeVisible();
	expect((await read(request)).state.accounts.A.entries).toEqual([
		{ key: "theme", value: "dark", updatedAt: 200 },
	]);
	await action(request, "allow-delete");
	await dialog
		.getByRole("button", { name: "Delete cloud copy", exact: true })
		.click();
	await expect(
		page.getByText("Cloud copy deleted", { exact: true })
	).toBeVisible();
	expect((await read(request)).state.accounts.A.entries).toEqual([]);
	expect(await local(page, "theme")).toBe("dark");
	const afterDeletePulls = await pullCount(page);
	await page.getByRole("button", { name: "Sync now", exact: true }).click();
	await settled(page, afterDeletePulls);
	const fresh = await read(request);
	expect(
		fresh.calls.filter((c) => c.path.includes("/pull?")).at(-1)
	).toMatchObject({
		authorization: "Bearer account-A",
		response: { entries: [], updatedAt: 0, revision: 0 },
	});
	expect(fresh.state.accounts.A.entries).toEqual([]);
	expect(
		(await read(request)).calls.filter((c) => c.method === "DELETE")
	).toHaveLength(2);
});

test("restart has one real keepalive flush and stopped engine has no visibility traffic", async ({
	page,
	request,
}) => {
	await seed(page, request);
	await settled(page);
	await page
		.getByRole("button", { name: "Stop settings engine", exact: true })
		.click();
	const pulls = (await read(request)).calls.filter((c) =>
		c.path.includes("/pull?")
	).length;
	const restartConsumed = await pullCount(page);
	await page
		.getByRole("button", { name: "Start settings engine", exact: true })
		.click();
	await expect
		.poll(
			async () =>
				(await read(request)).calls.filter((c) => c.path.includes("/pull?"))
					.length
		)
		.toBe(pulls + 1);
	await settled(page, restartConsumed);
	await page.evaluate(() => {
		localStorage.setItem("ryu_ui_font", "Owned lifecycle font");
		window.dispatchEvent(new PageTransitionEvent("pagehide"));
	});
	await expect
		.poll(
			async () =>
				(await read(request)).calls.filter((c) => c.method === "POST").length
		)
		.toBe(1);
	await expect
		.poll(async () =>
			(await read(request)).state.accounts.A.entries.some(
				(e) => e.key === "ryu_ui_font" && e.value === "Owned lifecycle font"
			)
		)
		.toBe(true);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					Reflect.get(window, "__syncProof").issued.filter(
						(c: { method: string; keepalive: boolean }) =>
							c.method === "POST" && c.keepalive
					).length
			)
		)
		.toBe(1);
	await page
		.getByRole("button", { name: "Stop settings engine", exact: true })
		.click();
	const before = (await read(request)).calls.length;
	const issuedBefore = await page.evaluate(
		() => Reflect.get(window, "__syncProof").issued.length
	);
	// Visible-window lifecycle event is dispatched after the real cleanup. The
	// listener itself calls shipping syncNow, with actual native HTTP if leaked.
	await page.evaluate(() =>
		document.dispatchEvent(new Event("visibilitychange"))
	);
	expect(
		await page.evaluate(() => Reflect.get(window, "__syncProof").issued.length)
	).toBe(issuedBefore);
	expect((await read(request)).calls).toHaveLength(before);
});

for (const aba of [false, true]) {
	test(`held cloud shortcut pull cannot write under ${aba ? "returned Core A epoch" : "Core B authority"}`, async ({
		page,
		request,
	}) => {
		const old = JSON.stringify({ "chat.send": "Enter" });
		const next = JSON.stringify({ "chat.send": "Mod+Enter" });
		const key = await shortcutKey(page);
		await seed(page, request, {
			remote: [{ key, value: next, updatedAt: 200 }],
			meta: { [key]: 10 },
			cursor: 10,
			shortcuts: old,
			holdPull: true,
		});
		const id = await held(request);
		await page
			.getByRole("button", { name: "Select Core B", exact: true })
			.click();
		if (aba) {
			await page
				.getByRole("button", { name: "Select Core A", exact: true })
				.click();
		}
		await release(page, request, id);
		const retired = await read(request);
		expect(
			retired.calls.filter((c) => c.method === "PUT" || c.method === "POST")
		).toEqual([]);
		expect(retired.state.shortcuts).toBe(old);
		expect(retired.state.otherShortcuts).toBe(old);
		expect(
			await page.evaluate(() =>
				Reflect.get(window, "__syncProof").readShortcuts()
			)
		).toEqual(JSON.parse(old));
		// The Core scope change asks for a whole-document pull without zeroing
		// the cursor that bounds which settings count as pending local edits.
		expect(await local(page, "ryu:settings-sync-cursor")).toBe("10");
		expect(
			await local(page, "ryu:settings-sync-full-pull:owned-account-A")
		).toBe("1");
		const before = await pullCount(page);
		await page.getByRole("button", { name: "Sync now", exact: true }).click();
		await settled(page, before);
		const fresh = await read(request);
		expect(
			fresh.calls.filter((c) => c.path.includes("/pull?")).at(-1)
		).toMatchObject({ path: "/api/desktop-settings-sync/pull?since=0" });
		expect(
			await local(page, "ryu:settings-sync-full-pull:owned-account-A")
		).toBeNull();
		expect(fresh.calls.filter((c) => c.method === "PUT")).toEqual([
			expect.objectContaining({
				path: aba
					? "/core/api/preferences/keybindings"
					: "/other-core/api/preferences/keybindings",
				authorization: aba ? "Bearer owned-core" : "Bearer owned-core-B",
				body: { value: next },
				settled: true,
			}),
		]);
		expect(fresh.state.shortcuts).toBe(aba ? next : old);
		expect(fresh.state.otherShortcuts).toBe(aba ? old : next);
		expect(
			await page.evaluate(() =>
				Reflect.get(window, "__syncProof").readShortcuts()
			)
		).toEqual(JSON.parse(next));
		expect(fresh.calls.filter((c) => c.method === "POST")).toEqual([]);
		expect(await local(page, "ryu:settings-sync-cursor")).toBe("200");
	});
}

test("accepted Core A shortcut cache cannot claim different durable Core B bindings are synced", async ({
	page,
	request,
}) => {
	const old = JSON.stringify({ "chat.send": "Enter" });
	const next = JSON.stringify({ "chat.send": "Mod+Enter" });
	const key = await shortcutKey(page);
	await seed(page, request, {
		remote: [{ key, value: next, updatedAt: 200 }],
		meta: { [key]: 10 },
		cursor: 10,
		shortcuts: old,
	});
	await settled(page);
	const first = await read(request);
	expect(first.state.shortcuts).toBe(next);
	expect(first.state.otherShortcuts).toBe(old);
	expect(first.calls.filter((c) => c.method === "PUT")).toEqual([
		expect.objectContaining({
			path: "/core/api/preferences/keybindings",
			authorization: "Bearer owned-core",
			body: { value: next },
			settled: true,
		}),
	]);
	await page
		.getByRole("button", { name: "Select Core B", exact: true })
		.click();
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "__syncProof").readShortcuts()
		)
	).toEqual(JSON.parse(old));
	const before = await pullCount(page);
	await page.getByRole("button", { name: "Sync now", exact: true }).click();
	await settled(page, before);
	const second = await read(request);
	expect(second.state.shortcuts).toBe(next);
	expect(second.state.otherShortcuts).toBe(next);
	expect(second.calls.filter((c) => c.method === "PUT")).toEqual([
		expect.objectContaining({
			path: "/core/api/preferences/keybindings",
			authorization: "Bearer owned-core",
			body: { value: next },
		}),
		expect.objectContaining({
			path: "/other-core/api/preferences/keybindings",
			authorization: "Bearer owned-core-B",
			body: { value: next },
		}),
	]);
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "__syncProof").readShortcuts()
		)
	).toEqual(JSON.parse(next));
	await expect(page.getByText("Up to date", { exact: true })).toBeVisible();
	expect(second.calls.filter((c) => c.method === "POST")).toEqual([]);
});

test("stopped engine changing Core cannot inherit the previous Core saved shortcut cache on restart", async ({
	page,
	request,
}) => {
	const old = JSON.stringify({ "chat.send": "Enter" });
	const next = JSON.stringify({ "chat.send": "Mod+Enter" });
	const key = await shortcutKey(page);
	await seed(page, request, {
		remote: [{ key, value: next, updatedAt: 200 }],
		meta: { [key]: 10 },
		cursor: 10,
		shortcuts: old,
	});
	await settled(page);
	expect((await read(request)).state.shortcuts).toBe(next);
	expect((await read(request)).state.otherShortcuts).toBe(old);
	await page
		.getByRole("button", { name: "Stop settings engine", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Select Core B", exact: true })
		.click();
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "__syncProof").readShortcuts()
		)
	).toEqual(JSON.parse(old));
	const before = await pullCount(page);
	await page
		.getByRole("button", { name: "Start settings engine", exact: true })
		.click();
	await settled(page, before);
	const receipt = await read(request);
	expect(receipt.state.shortcuts).toBe(next);
	expect(receipt.state.otherShortcuts).toBe(next);
	expect(receipt.calls.filter((c) => c.method === "PUT")).toEqual([
		expect.objectContaining({
			path: "/core/api/preferences/keybindings",
			authorization: "Bearer owned-core",
			body: { value: next },
		}),
		expect.objectContaining({
			path: "/other-core/api/preferences/keybindings",
			authorization: "Bearer owned-core-B",
			body: { value: next },
		}),
	]);
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "__syncProof").readShortcuts()
		)
	).toEqual(JSON.parse(next));
	expect(receipt.calls.filter((c) => c.method === "POST")).toEqual([]);
});

test("re-enabling while retired pull is held automatically runs one fresh cycle without manual retry", async ({
	page,
	request,
}) => {
	await seed(page, request, {
		remote: [{ key: "theme", value: "light", updatedAt: 200 }],
		local: { theme: "dark", ryu_ui_font: "Inter" },
		meta: { theme: 10, ryu_ui_font: 100 },
		cursor: 10,
		holdPull: true,
	});
	const id = await held(request);
	await page.getByRole("switch").click();
	await expect(page.getByRole("switch")).toHaveAttribute(
		"aria-checked",
		"false"
	);
	await page.getByRole("switch").click();
	await expect(page.getByRole("switch")).toHaveAttribute(
		"aria-checked",
		"true"
	);
	await action(request, "release", { id });
	await expect.poll(() => pullCount(page)).toBe(2);
	await expect
		.poll(() =>
			page.evaluate(() => Reflect.get(window, "__syncProof").status())
		)
		.toBe("idle");
	const receipt = await read(request);
	expect(receipt.calls.filter((c) => c.path.includes("/pull?"))).toEqual([
		expect.objectContaining({
			authorization: "Bearer account-A",
			path: "/api/desktop-settings-sync/pull?since=10",
			settled: true,
		}),
		expect.objectContaining({
			authorization: "Bearer account-A",
			path: "/api/desktop-settings-sync/pull?since=10",
			settled: true,
		}),
	]);
	expect(receipt.calls.filter((c) => c.method === "POST")).toEqual([
		expect.objectContaining({
			authorization: "Bearer account-A",
			body: {
				entries: [
					{
						key: "ryu_ui_font",
						value: "Inter",
						updatedAt: 100,
						deleted: false,
					},
				],
			},
			settled: true,
		}),
	]);
	expect(receipt.state.accounts.A.entries).toEqual([
		{ key: "theme", value: "light", updatedAt: 200 },
		{ key: "ryu_ui_font", value: "Inter", updatedAt: 100, deleted: false },
	]);
	expect(await local(page, "theme")).toBe("light");
	expect(await local(page, "ryu:settings-sync-cursor")).toBe("200");
	await expect(page.getByText("Up to date", { exact: true })).toBeVisible();
});

test("Ask Use cloud keeps refused Core conflict visible and retries the exact chosen value", async ({
	page,
	request,
}) => {
	const key = await shortcutKey(page);
	const old = JSON.stringify({ "chat.send": "Enter" });
	const next = JSON.stringify({ "chat.send": "Mod+Enter" });
	await seed(page, request, {
		remote: [{ key, value: next, updatedAt: 200 }],
		// Account A's own pending shortcut set, captured from its own edits.
		local: ownShortcutEdit(key, old),
		meta: { [key]: 100 },
		cursor: 10,
		shortcuts: old,
		refuseShortcut: true,
		expectedShortcutKey: key,
	});
	await settled(page);
	await expect(
		page.getByRole("heading", { name: "1 setting needs a decision" })
	).toBeVisible();
	expect(
		(await read(request)).calls.filter(
			(c) => c.method === "POST" || c.method === "PUT"
		)
	).toEqual([]);
	await page.getByRole("button", { name: "Use cloud", exact: true }).click();
	await expect
		.poll(
			async () =>
				(await read(request)).calls.filter(
					(c) => c.method === "PUT" && c.settled
				).length
		)
		.toBe(1);
	await expect(
		page.getByText("Sync incomplete", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Use cloud", exact: true })
	).toBeVisible();
	expect((await read(request)).state.shortcuts).toBe(old);
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "__syncProof").readShortcuts()
		)
	).toEqual(JSON.parse(old));
	expect(
		JSON.parse((await local(page, "ryu:settings-sync-value-cache")) ?? "{}")[
			key
		]
	).toBe(old);
	await action(request, "allow-shortcut");
	await page.getByRole("button", { name: "Use cloud", exact: true }).click();
	await expect
		.poll(async () => (await read(request)).state.shortcuts)
		.toBe(next);
	await expect(
		page.getByRole("button", { name: "Use cloud", exact: true })
	).toHaveCount(0);
	await expect(page.getByText("Up to date", { exact: true })).toBeVisible();
	const receipt = await read(request);
	expect(
		receipt.calls.filter((c) => c.method === "PUT").map((c) => c.body)
	).toEqual([{ value: next }, { value: next }]);
	expect(receipt.calls.filter((c) => c.method === "POST")).toEqual([]);
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "__syncProof").readShortcuts()
		)
	).toEqual(JSON.parse(next));
});
test("bulk Use cloud resolves accepted appearance and retains the refused shortcut decision", async ({
	page,
	request,
}) => {
	const key = await shortcutKey(page);
	const old = JSON.stringify({ "chat.send": "Enter" });
	const next = JSON.stringify({ "chat.send": "Mod+Enter" });
	await seed(page, request, {
		remote: [
			{ key: "theme", value: "light", updatedAt: 200 },
			{ key, value: next, updatedAt: 200 },
		],
		local: { theme: "dark", ...ownShortcutEdit(key, old) },
		meta: { theme: 100, [key]: 100 },
		cursor: 10,
		shortcuts: old,
		refuseShortcut: true,
		expectedShortcutKey: key,
	});
	await settled(page);
	await expect(
		page.getByRole("heading", { name: "2 settings need a decision" })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Use cloud for all", exact: true })
		.click();
	await expect
		.poll(
			async () =>
				(await read(request)).calls.filter(
					(c) => c.method === "PUT" && c.settled
				).length
		)
		.toBe(1);
	expect(await local(page, "theme")).toBe("light");
	expect((await read(request)).state.shortcuts).toBe(old);
	await expect(
		page.getByRole("heading", { name: "1 setting needs a decision" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Use cloud", exact: true })
	).toHaveCount(1);
	expect(
		(await read(request)).calls.filter((c) => c.method === "POST")
	).toEqual([]);
	await action(request, "allow-shortcut");
	await page.getByRole("button", { name: "Use cloud", exact: true }).click();
	await expect
		.poll(async () => (await read(request)).state.shortcuts)
		.toBe(next);
	await expect(
		page.getByRole("button", { name: "Use cloud", exact: true })
	).toHaveCount(0);
	expect(await local(page, "theme")).toBe("light");
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "__syncProof").readShortcuts()
		)
	).toEqual(JSON.parse(next));
	expect(
		(await read(request)).calls
			.filter((c) => c.method === "PUT")
			.map((c) => c.body)
	).toEqual([{ value: next }, { value: next }]);
});
test("invalid shortcut JSON cannot replace durable bindings or report a completed sync", async ({
	page,
	request,
}) => {
	const key = await shortcutKey(page);
	const old = JSON.stringify({ "chat.send": "Enter" });
	await seed(page, request, {
		remote: [{ key, value: "{invalid JSON", updatedAt: 200 }],
		meta: { [key]: 10 },
		cursor: 10,
		shortcuts: old,
		expectedShortcutKey: key,
	});
	await settled(page);
	await expect(
		page.getByText("Sync incomplete", { exact: true })
	).toBeVisible();
	expect(await local(page, "ryu:settings-sync-cursor")).toBe("10");
	expect(
		JSON.parse((await local(page, "ryu:settings-sync-meta")) ?? "{}")[key]
	).toBe(10);
	expect((await read(request)).state.shortcuts).toBe(old);
	expect(
		(await read(request)).calls.filter(
			(c) => c.method === "PUT" || c.method === "POST"
		)
	).toEqual([]);
	const before = await pullCount(page);
	await page.getByRole("button", { name: "Sync now", exact: true }).click();
	await settled(page, before);
	await expect(
		page.getByText("Couldn't sync settings", { exact: true })
	).toBeVisible();
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "__syncProof").readShortcuts()
		)
	).toEqual(JSON.parse(old));
	expect(
		(await read(request)).calls.filter((c) => c.path.includes("/pull?"))
	).toHaveLength(2);
	expect(
		(await read(request)).calls.filter(
			(c) => c.method === "PUT" || c.method === "POST"
		)
	).toEqual([]);
});
test("native incoming and outgoing allowlists preserve credentials machine paths and foreign OS shortcuts", async ({
	page,
	request,
}) => {
	const key = await shortcutKey(page);
	const foreign =
		key === "keybindings:darwin" ? "keybindings:win32" : "keybindings:darwin";
	const old = JSON.stringify({ "chat.send": "Enter" });
	const incoming = [
		{ key: "theme", value: "light", updatedAt: 200 },
		{ key: "ryu_session_token", value: "account-B", updatedAt: 200 },
		{ key: "ryu_workspace_path", value: "/foreign/workspace", updatedAt: 200 },
		{ key: "ryu:node-config", value: "foreign-node", updatedAt: 200 },
		{
			key: foreign,
			value: JSON.stringify({ "chat.send": "Alt+Enter" }),
			updatedAt: 200,
		},
	];
	await seed(page, request, {
		remote: incoming,
		local: {
			theme: "dark",
			ryu_ui_font: "Inter",
			ryu_workspace_path: "/owned/private",
			"ryu:node-config": "owned-node",
		},
		meta: {
			theme: 10,
			ryu_ui_font: 100,
			ryu_session_token: 100,
			ryu_workspace_path: 100,
			"ryu:node-config": 100,
			[foreign]: 100,
		},
		cursor: 10,
		shortcuts: old,
		expectedShortcutKey: key,
	});
	await settled(page);
	expect(await local(page, "theme")).toBe("light");
	expect(await local(page, "ryu_session_token")).toBe("account-A");
	expect(await local(page, "ryu_workspace_path")).toBe("/owned/private");
	expect(await local(page, "ryu:node-config")).toBe("owned-node");
	const receipt = await read(request);
	expect(receipt.state.shortcuts).toBe(old);
	expect(receipt.state.otherShortcuts).toBe(old);
	expect(receipt.calls.filter((c) => c.method === "PUT")).toEqual([]);
	expect(receipt.calls.filter((c) => c.method === "POST")).toEqual([
		expect.objectContaining({
			authorization: "Bearer account-A",
			body: {
				entries: [
					{
						key: "ryu_ui_font",
						value: "Inter",
						updatedAt: 100,
						deleted: false,
					},
				],
			},
		}),
	]);
	expect(receipt.state.accounts.A.entries).toEqual([
		...incoming,
		{ key: "ryu_ui_font", value: "Inter", updatedAt: 100, deleted: false },
	]);
});
test("oversized unacknowledged setting remains pending without falsely reporting Up to date and valid retry persists", async ({
	page,
	request,
}) => {
	const key = "ryu_custom_themes";
	const themes = Array.from({ length: 200 }, (_, i) => ({
		id: `custom-proof-${i}`,
		label: `Saved ${i} ${"界".repeat(180)}`,
		mode: "dark",
		preview: { bg: "#000", surface: "#111", primary: "#00f", text: "#fff" },
		tokens: { "--background": "#000", "--foreground": "#fff" },
	}));
	const oversized = JSON.stringify(themes);
	const valid = JSON.stringify([themes[0]]);
	expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(
		128 * 1024
	);
	await seed(page, request, {
		local: { [key]: oversized, "ryu:settings-sync-last": "123" },
		meta: { [key]: 100 },
	});
	await settled(page);
	let receipt = await read(request);
	expect(
		receipt.calls.filter((c) => c.method === "POST").map((c) => c.response)
	).toEqual([{ applied: [], rejected: [], updatedAt: 0, revision: 0 }]);
	expect(receipt.state.accounts.A.entries).toEqual([]);
	expect(await local(page, key)).toBe(oversized);
	await expect(page.getByText(/1 change waiting to upload/)).toBeVisible();
	await expect(page.getByText("Up to date", { exact: true })).toHaveCount(0);
	expect(await local(page, "ryu:settings-sync-last")).toBe("123");
	const retryBefore = await pullCount(page);
	await page.getByRole("button", { name: "Sync now", exact: true }).click();
	await settled(page, retryBefore);
	receipt = await read(request);
	expect(
		receipt.calls.filter((c) => c.method === "POST").map((c) => c.response)
	).toEqual([
		{ applied: [], rejected: [], updatedAt: 0, revision: 0 },
		{ applied: [], rejected: [], updatedAt: 0, revision: 0 },
	]);
	expect(receipt.state.accounts.A.entries).toEqual([]);
	expect(await local(page, key)).toBe(oversized);
	expect(await local(page, "ryu:settings-sync-last")).toBe("123");
	await expect(
		page.getByText("Changes are still waiting to upload", { exact: true })
	).toBeVisible();
	await expect(page.getByText("Settings synced", { exact: true })).toHaveCount(
		0
	);
	await expect(page.getByText("Up to date", { exact: true })).toHaveCount(0);
	await page.evaluate(({ key, valid }) => localStorage.setItem(key, valid), {
		key,
		valid,
	});
	const before = await pullCount(page);
	await page.getByRole("button", { name: "Sync now", exact: true }).click();
	await settled(page, before);
	receipt = await read(request);
	expect(receipt.state.accounts.A.entries).toEqual([
		{ key, value: valid, updatedAt: expect.any(Number), deleted: false },
	]);
	await expect(page.getByText("Up to date", { exact: true })).toBeVisible();
	await expect(
		page.getByText(/^\d+ changes? waiting to upload\. Last synced /)
	).toHaveCount(0);
	await expect(
		page.getByText("Settings synced", { exact: true })
	).toBeVisible();
	expect(Number(await local(page, "ryu:settings-sync-last"))).toBeGreaterThan(
		123
	);
});

test("unacknowledged older setting survives a fresh document after an unrelated newer cloud cursor", async ({
	page,
	request,
}) => {
	const key = "ryu_custom_themes";
	const themes = Array.from({ length: 200 }, (_, i) => ({
		id: `reload-proof-${i}`,
		label: `Saved ${i} ${"界".repeat(180)}`,
		mode: "dark",
		preview: { bg: "#000", surface: "#111", primary: "#00f", text: "#fff" },
		tokens: { "--background": "#000", "--foreground": "#fff" },
	}));
	const oversized = JSON.stringify(themes);
	const valid = JSON.stringify([themes[0]]);
	expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(
		128 * 1024
	);
	await seed(page, request, {
		remote: [{ key: "theme", value: "light", updatedAt: 200 }],
		local: { [key]: oversized, "ryu:settings-sync-last": "123" },
		meta: { [key]: 100 },
		preserveOnReload: true,
	});
	await settled(page);
	let receipt = await read(request);
	expect(receipt.state.accounts.A.entries).toEqual([
		{ key: "theme", value: "light", updatedAt: 200 },
	]);
	expect(
		receipt.calls.filter((c) => c.method === "POST").map((c) => c.response)
	).toEqual([{ applied: [], rejected: [], updatedAt: 200, revision: 1 }]);
	expect(await local(page, "theme")).toBe("light");
	expect(await local(page, "ryu:settings-sync-cursor")).toBe("200");
	expect(
		JSON.parse((await local(page, "ryu:settings-sync-meta")) ?? "{}")[key]
	).toBe(100);
	expect(await local(page, key)).toBe(oversized);
	// Stop the genuine engine before reload so a pagehide keepalive cannot act
	// as an unobserved rescue upload; a new JS document must reconstruct pending.
	await page
		.getByRole("button", { name: "Stop settings engine", exact: true })
		.click();
	await expect
		.poll(async () => (await read(request)).calls.every((c) => c.settled))
		.toBe(true);
	const issuedBefore = receipt.calls.filter((c) => c.method === "POST").length;
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Settings Sync", exact: true })
	).toBeVisible();
	await expect
		.poll(
			async () =>
				(await read(request)).calls.filter(
					(c) => c.method === "GET" && c.path.includes("/pull?") && c.settled
				).length
		)
		.toBe(2);
	await expect
		.poll(() =>
			page.evaluate(() => Reflect.get(window, "__syncProof").status())
		)
		.not.toBe("syncing");
	expect(await local(page, key)).toBe(oversized);
	await expect(page.getByText(/1 change waiting to upload/)).toBeVisible();
	await expect(page.getByText("Up to date", { exact: true })).toHaveCount(0);
	receipt = await read(request);
	expect(receipt.calls.filter((c) => c.method === "POST")).toHaveLength(
		issuedBefore + 1
	);
	expect(
		receipt.calls.filter((c) => c.method === "POST").map((c) => c.response)
	).toEqual([
		{ applied: [], rejected: [], updatedAt: 200, revision: 1 },
		{ applied: [], rejected: [], updatedAt: 200, revision: 1 },
	]);
	expect(receipt.state.accounts.A.entries).toEqual([
		{ key: "theme", value: "light", updatedAt: 200 },
	]);
	expect(await local(page, "ryu:settings-sync-last")).toBe("123");
	await page.evaluate(({ key, valid }) => localStorage.setItem(key, valid), {
		key,
		valid,
	});
	const before = await pullCount(page);
	await page.getByRole("button", { name: "Sync now", exact: true }).click();
	await settled(page, before);
	receipt = await read(request);
	expect(receipt.state.accounts.A.entries).toEqual([
		{ key: "theme", value: "light", updatedAt: 200 },
		{ key, value: valid, updatedAt: expect.any(Number), deleted: false },
	]);
	await expect(page.getByText("Up to date", { exact: true })).toBeVisible();
	await expect(
		page.getByText(/^\d+ changes? waiting to upload\. Last synced /)
	).toHaveCount(0);
	expect(Number(await local(page, "ryu:settings-sync-last"))).toBeGreaterThan(
		123
	);
});

test("a newer local edit survives the exact old push acknowledgment and uploads on retry", async ({
	page,
	request,
}) => {
	const key = "ryu_ui_font";
	const old = "Inter";
	const next = "Geist";
	await seed(page, request, {
		local: { [key]: old, "ryu:settings-sync-last": "123" },
		meta: { [key]: 100 },
		holdPushAck: true,
	});
	const id = await held(request);
	let released = false;
	try {
		const before = await read(request);
		const oldPush = before.calls.find((c) => c.id === id);
		expect(oldPush).toMatchObject({
			method: "POST",
			path: "/api/desktop-settings-sync/push",
			authorization: "Bearer account-A",
			body: { entries: [{ key, value: old, updatedAt: 100, deleted: false }] },
			settled: false,
		});
		expect(before.state.accounts.A.entries).toEqual([
			{ key, value: old, updatedAt: 100, deleted: false },
		]);
		await page.evaluate(({ key, next }) => localStorage.setItem(key, next), {
			key,
			next,
		});
		const changedAt = await page.evaluate(
			(key) =>
				JSON.parse(localStorage.getItem("ryu:settings-sync-meta") ?? "{}")[key],
			key
		);
		expect(changedAt).toBeGreaterThan(100);
		await action(request, "release", { id });
		released = true;
		await expect
			.poll(() =>
				page.evaluate(() => Reflect.get(window, "__syncProof").status())
			)
			.not.toBe("syncing");
		const after = await read(request);
		expect(after.calls.filter((c) => c.method === "POST")).toHaveLength(1);
		expect(after.calls.find((c) => c.id === id)?.response).toEqual({
			applied: [key],
			rejected: [],
			updatedAt: 100,
			revision: 1,
		});
		expect(after.state.accounts.A.entries).toEqual([
			{ key, value: old, updatedAt: 100, deleted: false },
		]);
		expect(await local(page, key)).toBe(next);
		expect(
			JSON.parse((await local(page, "ryu:settings-sync-meta")) ?? "{}")[key]
		).toBe(changedAt);
		await expect(page.getByText(/1 change waiting to upload/)).toBeVisible();
		await expect(page.getByText("Up to date", { exact: true })).toHaveCount(0);
		expect(await local(page, "ryu:settings-sync-last")).toBe("123");
		const pulls = await pullCount(page);
		await page.getByRole("button", { name: "Sync now", exact: true }).click();
		await settled(page, pulls);
		const final = await read(request);
		expect(
			final.calls.filter((c) => c.method === "POST").map((c) => c.body)
		).toEqual([
			{ entries: [{ key, value: old, updatedAt: 100, deleted: false }] },
			{ entries: [{ key, value: next, updatedAt: changedAt, deleted: false }] },
		]);
		expect(final.state.accounts.A.entries).toEqual([
			{ key, value: next, updatedAt: changedAt, deleted: false },
		]);
		expect(final.state.accounts.A.revision).toBe(2);
		expect(final.state.accounts.B.entries).toEqual([]);
		await expect(page.getByText("Up to date", { exact: true })).toBeVisible();
		await expect(
			page.getByText(/^\d+ changes? waiting to upload\. Last synced /)
		).toHaveCount(0);
		expect(await local(page, key)).toBe(next);
		expect(Number(await local(page, "ryu:settings-sync-last"))).toBeGreaterThan(
			123
		);
	} finally {
		// Even a failed pre-release oracle must let the genuine old request settle.
		if (!released) {
			await action(request, "release", { id });
		}
		await expect
			.poll(async () => {
				const receipt = await read(request);
				return receipt.calls.find((c) => c.id === id)?.settled;
			})
			.toBe(true);
	}
});

// Validate storage trust through user-visible sync and physical HTTP effects.
test("a recovered ordinary draft uploads while forged journal keys cannot export credentials or Core shortcuts", async ({
	page,
	request,
}) => {
	const key = "ryu_ui_font";
	const own = await shortcutKey(page);
	const foreign =
		own === "keybindings:darwin" ? "keybindings:win32" : "keybindings:darwin";
	const journal = JSON.stringify({
		[key]: 100,
		ryu_session_token: 100,
		ryu_workspace_path: 100,
		"ryu:node-config": 100,
		[own]: 100,
		[foreign]: 100,
		ryu_custom_themes: "100",
		ryu_ui_scale: { at: 100 },
	});
	await seed(page, request, {
		remote: [{ key: "theme", value: "light", updatedAt: 201 }],
		local: {
			theme: "dark",
			[key]: "Inter",
			ryu_workspace_path: "/owned/private",
			"ryu:node-config": "owned-node",
			"ryu:settings-sync-pending-local": journal,
		},
		meta: {
			theme: 10,
			[key]: 100,
			ryu_session_token: 100,
			ryu_workspace_path: 100,
			"ryu:node-config": 100,
			[own]: 100,
			[foreign]: 100,
		},
		cursor: 200,
	});
	await settled(page);
	const receipt = await read(request);
	expect(
		receipt.calls
			.filter((c) => c.method === "POST")
			.map((c) => ({ authorization: c.authorization, body: c.body }))
	).toEqual([
		{
			authorization: "Bearer account-A",
			body: {
				entries: [{ key, value: "Inter", updatedAt: 100, deleted: false }],
			},
		},
	]);
	expect(receipt.state.accounts.A.entries).toEqual([
		{ key: "theme", value: "light", updatedAt: 201 },
		{ key, value: "Inter", updatedAt: 100, deleted: false },
	]);
	expect(receipt.state.accounts.B.entries).toEqual([]);
	expect(receipt.calls.filter((c) => c.method === "PUT")).toEqual([]);
	expect(await local(page, "ryu_session_token")).toBe("account-A");
	expect(await local(page, "ryu_workspace_path")).toBe("/owned/private");
	expect(await local(page, "ryu:node-config")).toBe("owned-node");
	expect(await local(page, key)).toBe("Inter");
	expect(await local(page, "theme")).toBe("light");
	await expect(page.getByText("Up to date", { exact: true })).toBeVisible();
	await expect(
		page.getByText(/^\d+ changes? waiting to upload\. Last synced /)
	).toHaveCount(0);
});

// Genuine native browser quota refusal with independent cloud readback.
test("a genuinely refused local appearance write cannot report cloud settings saved and retries after storage space returns", async ({
	page,
	request,
}, info) => {
	await seed(page, request, { local: { theme: "dark" } });
	await settled(page);
	const beforeLast = await local(page, "ryu:settings-sync-last");
	const initial = await read(request);
	expect(initial.calls.filter((c) => c.method === "POST")).toEqual([]);
	await info.attach("initial-before-quota-native-ledger", {
		body: JSON.stringify(initial, null, 2),
		contentType: "application/json",
	});
	// All genuine SDK/bootstrap writes have settled before filling local storage.
	const quota = await page.evaluate(() => {
		const key = "owned-proof-quota-padding";
		const limit = 8 * 1024 * 1024;
		let lo = 0;
		let hi = limit;
		let refused = false;
		let name = "";
		// One padding key, bounded8Mi code units. Binary search the browser's actual
		// remaining capacity; original native setItem throws the real DOMException.
		while (lo < hi) {
			const size = Math.ceil((lo + hi) / 2);
			try {
				localStorage.setItem(key, "q".repeat(size));
				lo = size;
			} catch (error) {
				if (
					!(
						error instanceof DOMException && error.name === "QuotaExceededError"
					)
				) {
					throw error;
				}
				refused = true;
				name = error.name;
				hi = size - 1;
			}
		}
		localStorage.setItem(key, "q".repeat(lo));
		// Add one character to the exact existing target to prove theme itself is
		// refused, rather than extrapolating a padding failure into a settings claim.
		let targetRefused = false;
		try {
			localStorage.setItem("theme", "light");
		} catch (error) {
			if (
				!(error instanceof DOMException && error.name === "QuotaExceededError")
			) {
				throw error;
			}
			targetRefused = true;
		}
		return {
			refused,
			name,
			targetRefused,
			size: lo,
			value: localStorage.getItem("theme"),
		};
	});
	await info.attach("actual-browser-quota-precondition", {
		body: JSON.stringify(quota, null, 2),
		contentType: "application/json",
	});
	expect(quota).toMatchObject({
		refused: true,
		name: "QuotaExceededError",
		targetRefused: true,
		value: "dark",
	});
	expect(quota.size).toBeGreaterThan(0);
	expect(quota.size).toBeLessThanOrEqual(8 * 1024 * 1024);
	// Replace only the finite independent remote document to model another device.
	// Prior initial native ledger is attached separately; no shipping route mocks.
	await action(request, "reset", {
		state: {
			accounts: {
				A: {
					entries: [{ key: "theme", value: "light", updatedAt: 200 }],
					revision: 1,
					updatedAt: 200,
				},
				B: { entries: [], revision: 0, updatedAt: 0 },
			},
			shortcuts: "{}",
			otherShortcuts: "{}",
		},
	});
	const pulls = await pullCount(page);
	await page.getByRole("button", { name: "Sync now", exact: true }).click();
	await settled(page, pulls);
	expect(await local(page, "theme")).toBe("dark");
	expect(await local(page, "ryu:settings-sync-last")).toBe(beforeLast);
	let receipt = await read(request);
	expect(receipt.state.accounts.A.entries).toEqual([
		{ key: "theme", value: "light", updatedAt: 200 },
	]);
	expect(
		receipt.calls.filter((c) => c.method === "POST" || c.method === "PUT")
	).toEqual([]);
	await expect(
		page.getByText("Sync incomplete", { exact: true })
	).toBeVisible();
	await expect(page.getByText("Up to date", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Settings synced", { exact: true })).toHaveCount(
		0
	);
	await page.evaluate(() =>
		localStorage.removeItem("owned-proof-quota-padding")
	);
	const retry = await pullCount(page);
	await page.getByRole("button", { name: "Sync now", exact: true }).click();
	await settled(page, retry);
	expect(await local(page, "theme")).toBe("light");
	await expect(page.getByText("Up to date", { exact: true })).toBeVisible();
	receipt = await read(request);
	expect(receipt.state.accounts.A.entries).toEqual([
		{ key: "theme", value: "light", updatedAt: 200 },
	]);
	expect(receipt.state.accounts.B.entries).toEqual([]);
	expect(
		receipt.calls.filter((c) => c.method === "POST" || c.method === "PUT")
	).toEqual([]);
});
