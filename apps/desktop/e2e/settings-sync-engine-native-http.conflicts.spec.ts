import { expect, test } from "@playwright/test";
import {
	action,
	held,
	local,
	ownShortcutEdit,
	pullCount,
	read,
	registerNativeHttpLedgerHooks,
	seed,
	settled,
	shortcutKey,
} from "./settings-sync-engine-native-http.fixture.ts";

registerNativeHttpLedgerHooks();

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
