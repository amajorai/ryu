import { expect, test } from "@playwright/test";
import {
	action,
	held,
	local,
	pullCount,
	read,
	registerNativeHttpLedgerHooks,
	seed,
	settled,
	shortcutKey,
} from "./settings-sync-engine-native-http.fixture.ts";

registerNativeHttpLedgerHooks();

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
	// 99500215a7 dropped the section title that repeated the pane title.
	await expect(
		page.getByText("Sync My Settings Across Machines", { exact: true })
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
