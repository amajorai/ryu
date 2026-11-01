import { expect, test } from "@playwright/test";
import {
	action,
	held,
	local,
	pullCount,
	read,
	registerNativeHttpLedgerHooks,
	release,
	seed,
	settled,
	shortcutKey,
} from "./settings-sync-engine-native-http.fixture.ts";

registerNativeHttpLedgerHooks();

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
