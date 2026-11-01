import { expect, test } from "@playwright/test";
import {
	held,
	local,
	pullCount,
	read,
	registerNativeHttpLedgerHooks,
	release,
	seed,
	settled,
} from "./settings-sync-engine-native-http.fixture.ts";

registerNativeHttpLedgerHooks();

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
