import { expect, test } from "@playwright/test";
import {
	control,
	entryWrites,
	errors,
	HOST,
	pluginRow,
	record,
	registerNativeLedgerHooks,
	selectAuthority,
	settled,
	twoFrames,
	unexpected,
} from "./harness/plugin-shortcuts-proof/ledger.ts";

registerNativeLedgerHooks();
// Every chord and Reset is one `POST /api/keybindings/entry` (Core's locked
// per-entry edit, ec6fac15e2), not a client-side read and whole-document PUT:
// the receipts below assert those entry calls and the document Core stored.
test("retired A keybindings read cannot replace B's plugin recorder or overwrite unrelated B bindings in a genuine saved chord", async ({
	page,
	request,
}) => {
	await control(request, { holdRead: true });
	await page.goto("/index.html");
	await expect.poll(async () => (await control(request)).held.length).toBe(1);
	const before = await control(request);
	await page.evaluate(() =>
		(
			window as unknown as {
				__PLUGIN_AUTHORITY__: { select: (key: "b") => void };
			}
		).__PLUGIN_AUTHORITY__.select("b")
	);
	await expect(pluginRow(page, "B Shared companion")).toBeVisible();
	const retired = page.waitForResponse(
		(response) => response.url() === `${HOST}/a/api/preferences/keybindings`
	);
	await control(request, { release: true });
	await (await retired).finished();
	await settled(request);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	const displayedBefore = await pluginRow(page, "B Shared companion")
		.locator("kbd")
		.allTextContents();
	await record(page, "B Shared companion", "Control+Alt+C");
	await expect
		.poll(
			async () =>
				entryWrites(await control(request)).filter(
					(call) => call.completed && call.admitted
				).length
		)
		.toBe(1);
	const receipt = await control(request);
	expect(receipt.disk.a).toEqual(before.disk.a);
	expect(receipt.disk.b).toEqual({
		...before.disk.b,
		"plugin:proof-shared": "CommandOrControl+Alt+C",
	});
	expect(displayedBefore).toEqual(["Ctrl", "Alt", "B"]);
	const write = entryWrites(receipt);
	expect(write).toHaveLength(1);
	expect(write[0]).toMatchObject({
		authority: "b",
		authorization: "Bearer plugin-token-b",
		endpoint: "/api/keybindings/entry",
		entry: { entry: "plugin:proof-shared", value: "CommandOrControl+Alt+C" },
		admitted: true,
		status: 200,
		document: receipt.disk.b,
	});
	await page.reload();
	await expect(pluginRow(page, "B Shared companion").locator("kbd")).toHaveText(
		["Ctrl", "Alt", "C"]
	);
	await expect(
		pluginRow(page, "B Unrelated companion").locator("kbd")
	).toHaveText(["Ctrl", "Alt", "U"]);
	expect(errors.get(page) ?? []).toEqual([]);
	expect(unexpected.get(page) ?? []).toEqual([]);
});
test("refused actual plugin chord conserves the saved whole document, reports failure and retries once without losing unrelated bindings", async ({
	page,
	request,
}) => {
	await page.addInitScript(() =>
		sessionStorage.setItem("plugin-proof-authority", "b")
	);
	await page.goto("/index.html");
	await expect(pluginRow(page, "B Shared companion").locator("kbd")).toHaveText(
		["Ctrl", "Alt", "B"]
	);
	const before = await control(request);
	await control(request, { refuseWrite: true });
	const refusalResponse = page.waitForResponse(
		(response) =>
			response.url() === `${HOST}/b/api/keybindings/entry` &&
			response.request().method() === "POST" &&
			response.status() === 503
	);
	await record(page, "B Shared companion", "Control+Alt+R");
	await (await refusalResponse).finished();
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	await expect
		.poll(
			async () =>
				entryWrites(await control(request)).filter(
					(call) => call.completed && call.status === 503
				).length
		)
		.toBe(1);
	expect((await control(request)).disk.b).toEqual(before.disk.b);
	const usefulFailure = await page
		.getByText("Couldn't update plugin shortcut", { exact: true })
		.count();
	await control(request, { refuseWrite: false });
	await record(page, "B Shared companion", "Control+Alt+R");
	await expect
		.poll(
			async () =>
				entryWrites(await control(request)).filter(
					(call) => call.completed && call.admitted
				).length
		)
		.toBe(1);
	const receipt = await control(request);
	const writes = entryWrites(receipt);
	expect(writes).toHaveLength(2);
	expect(
		writes.map((call) => ({
			authority: call.authority,
			entry: call.entry,
			status: call.status,
			admitted: call.admitted,
			authorization: call.authorization,
		}))
	).toEqual([
		{
			authority: "b",
			entry: { entry: "plugin:proof-shared", value: "CommandOrControl+Alt+R" },
			status: 503,
			admitted: false,
			authorization: "Bearer plugin-token-b",
		},
		{
			authority: "b",
			entry: { entry: "plugin:proof-shared", value: "CommandOrControl+Alt+R" },
			status: 200,
			admitted: true,
			authorization: "Bearer plugin-token-b",
		},
	]);
	expect(receipt.disk.a).toEqual(before.disk.a);
	expect(receipt.disk.b).toEqual({
		...before.disk.b,
		"plugin:proof-shared": "CommandOrControl+Alt+R",
	});
	await page.reload();
	await expect(pluginRow(page, "B Shared companion").locator("kbd")).toHaveText(
		["Ctrl", "Alt", "R"]
	);
	await expect(
		pluginRow(page, "B Unrelated companion").locator("kbd")
	).toHaveText(["Ctrl", "Alt", "U"]);
	expect(usefulFailure).toBe(1);
	expect(errors.get(page) ?? []).toEqual([]);
	expect(unexpected.get(page) ?? []).toEqual([]);
});

// Separate additive regressions; original two bodies and hooks above are unchanged.
test("Reset refusal preserves the saved full document; retry deletes only the shared override and survives reload", async ({
	page,
	request,
}) => {
	const seeded = {
		"plugin:proof-shared": "Control+Alt+A",
		"plugin:proof-a-only": "Control+Alt+X",
		"plugin:unknown-preserved": "Control+Alt+U",
		"plugin:explicit-null": null,
	};
	await control(request, {
		rawDocument: { authority: "a", bytes: JSON.stringify(seeded) },
	});
	await page.goto("/index.html");
	const row = pluginRow(page, "A Shared companion");
	await expect(row.locator("kbd")).toHaveText(["Ctrl", "Alt", "A"]);
	const before = await control(request);
	await control(request, { refuseWrite: true });
	const refused = page.waitForResponse(
		(r) =>
			r.url() === `${HOST}/a/api/keybindings/entry` &&
			r.request().method() === "POST" &&
			r.status() === 503
	);
	await row.getByRole("button", { name: "Reset", exact: true }).click();
	await (await refused).finished();
	await settled(request);
	await twoFrames(page);
	const retained = await control(request);
	const { "plugin:proof-shared": _removed, ...expected } = seeded;
	expect(entryWrites(retained)).toHaveLength(1);
	expect(entryWrites(retained)[0]).toMatchObject({
		authority: "a",
		status: 503,
		admitted: false,
		completed: true,
		entry: { entry: "plugin:proof-shared", remove: true },
	});
	expect(entryWrites(retained)[0]?.document).toBeUndefined();
	expect(retained.disk).toEqual(before.disk);
	expect(retained.rawDisk).toEqual(before.rawDisk);
	await expect(row.locator("kbd")).toHaveText(["Ctrl", "Alt", "A"]);
	await control(request, { refuseWrite: false });
	await row.getByRole("button", { name: "Reset", exact: true }).click();
	await expect
		.poll(
			async () =>
				entryWrites(await control(request)).filter(
					(c) => c.admitted && c.completed
				).length
		)
		.toBe(1);
	const saved = await control(request);
	expect(entryWrites(saved)).toHaveLength(2);
	expect(entryWrites(saved)[1]).toMatchObject({
		authority: "a",
		authorization: "Bearer plugin-token-a",
		entry: { entry: "plugin:proof-shared", remove: true },
		document: expected,
		status: 200,
		admitted: true,
	});
	expect(saved.disk.a).toEqual(expected);
	expect(saved.disk.b).toEqual(before.disk.b);
	await expect(row.locator("kbd")).toHaveText(["Ctrl", "Alt", "D"]);
	await expect(
		row.getByRole("button", { name: "Reset", exact: true })
	).toBeDisabled();
	await page.reload();
	await expect(row.locator("kbd")).toHaveText(["Ctrl", "Alt", "D"]);
	expect((await control(request)).disk).toEqual(saved.disk);
});

test("malformed native documents disable editing and never write; repaired full document loads only through explicit Retry", async ({
	page,
	request,
}) => {
	const malformed = [
		"{not-json",
		JSON.stringify(["Control+Alt+A"]),
		JSON.stringify({ "plugin:proof-shared": 42 }),
	];
	for (const bytes of malformed) {
		await control(request, { rawDocument: { authority: "a", bytes } });
		await page.goto("/index.html");
		const row = pluginRow(page, "A Shared companion");
		const retry = page.getByRole("button", {
			name: "Retry plugin shortcuts",
			exact: true,
		});
		await expect(retry).toBeVisible();
		const recorder = row.locator("button").filter({ has: page.locator("kbd") });
		await expect(recorder).toBeDisabled();
		await expect(
			row.getByRole("button", { name: "Reset", exact: true })
		).toBeDisabled();
		await page.keyboard.press("Control+Alt+Z");
		await twoFrames(page);
		await settled(request);
		const refused = await control(request);
		expect(entryWrites(refused)).toHaveLength(0);
		expect(refused.rawDisk.a.bytes).toBe(bytes);
	}
	const corruptReads = await control(request);
	for (const bytes of malformed) {
		expect(
			corruptReads.calls.some(
				(call) =>
					call.authority === "a" &&
					call.method === "GET" &&
					call.preferenceValue === bytes &&
					call.completed
			)
		).toBe(true);
	}
	const repaired = {
		"plugin:proof-shared": "Control+Alt+A",
		"plugin:proof-a-only": "Control+Alt+X",
		"plugin:preserved-null": null,
	};
	await control(request, {
		rawDocument: { authority: "a", bytes: JSON.stringify(repaired) },
	});
	const beforeRetry = await control(request);
	const reads = beforeRetry.calls.filter(
		(c) =>
			c.authority === "a" &&
			c.endpoint === "/api/preferences/keybindings" &&
			c.method === "GET"
	).length;
	await page
		.getByRole("button", { name: "Retry plugin shortcuts", exact: true })
		.click();
	const row = pluginRow(page, "A Shared companion");
	await expect(row.locator("kbd")).toHaveText(["Ctrl", "Alt", "A"]);
	await expect
		.poll(
			async () =>
				(await control(request)).calls.filter(
					(c) =>
						c.authority === "a" &&
						c.endpoint === "/api/preferences/keybindings" &&
						c.method === "GET" &&
						c.completed
				).length
		)
		.toBe(reads + 1);
	await record(page, "A Shared companion", "Control+Alt+R");
	await expect
		.poll(
			async () =>
				entryWrites(await control(request)).filter(
					(c) => c.admitted && c.completed
				).length
		)
		.toBe(1);
	const saved = await control(request);
	expect(saved.disk.a).toEqual({
		...repaired,
		"plugin:proof-shared": "CommandOrControl+Alt+R",
	});
	expect(entryWrites(saved)).toHaveLength(1);
	expect(saved.disk.b).toEqual(beforeRetry.disk.b);
	await page.reload();
	await expect(row.locator("kbd")).toHaveText(["Ctrl", "Alt", "R"]);
	expect((await control(request)).disk).toEqual(saved.disk);
	// A valid initial load cannot authorize replacing later externally corrupted
	// data: Core's locked entry edit refuses a stored document that is not a
	// JSON object instead of replacing it, and the editor reports the refusal.
	const stable = await control(request);
	const invalid = JSON.stringify(["plugin:proof-shared"]);
	for (const action of ["record", "reset"] as const) {
		await settled(request);
		await control(request, { rawDocument: { authority: "a", bytes: invalid } });
		const beforeWrite = await control(request);
		const oldWrites = entryWrites(beforeWrite).length;
		const refusedEdit = page.waitForResponse(
			(response) =>
				response.url() === `${HOST}/a/api/keybindings/entry` &&
				response.request().method() === "POST"
		);
		if (action === "record") {
			await record(page, "A Shared companion", "Control+Alt+Z");
		} else {
			await row.getByRole("button", { name: "Reset", exact: true }).click();
		}
		const observedRefusal = await refusedEdit;
		await observedRefusal.finished();
		expect(observedRefusal.status()).toBe(500);
		await settled(request);
		await expect(
			page.getByText("Couldn't update plugin shortcut", { exact: true })
		).toBeVisible();
		await twoFrames(page);
		const blocked = await control(request);
		expect(entryWrites(blocked)).toHaveLength(oldWrites + 1);
		expect(entryWrites(blocked).at(-1)).toMatchObject({
			authority: "a",
			entry:
				action === "record"
					? {
							entry: "plugin:proof-shared",
							value: "CommandOrControl+Alt+Z",
						}
					: { entry: "plugin:proof-shared", remove: true },
			status: 500,
			admitted: false,
			completed: true,
		});
		expect(blocked.rawDisk.a.bytes).toBe(invalid);
		expect(blocked.disk.b).toEqual(stable.disk.b);
		await expect(row.locator("kbd")).toHaveText(["Ctrl", "Alt", "R"]);
		await control(request, {
			rawDocument: { authority: "a", bytes: JSON.stringify(stable.disk.a) },
		});
		// A fresh document reload is an explicit user recovery barrier; allow legitimate failed-read reloads.
		await page.reload();
		await expect(row.locator("kbd")).toHaveText(["Ctrl", "Alt", "R"]);
		await expect(
			row.locator("button").filter({ has: page.locator("kbd") })
		).toBeEnabled();
		await expect(
			row.getByRole("button", { name: "Reset", exact: true })
		).toBeEnabled();
		await settled(request);
	}
	await page.reload();
	await expect(row.locator("kbd")).toHaveText(["Ctrl", "Alt", "R"]);
	expect((await control(request)).disk).toEqual(stable.disk);
});

// Since the per-entry route (ec6fac15e2) a chord is sent at once, so an
// A -> B -> A switch cannot retire an intent that never waited on a read; what
// the editor guarantees instead (usePluginShortcutOverrides.http.test.tsx) is
// that a write in flight lands only on the node it was addressed to and never
// repaints the editor it no longer belongs to.
test("synchronous A to B to A keeps a held A write on A without repainting the editor; only a fresh current-A chord changes what it shows", async ({
	page,
	request,
}) => {
	await page.goto("/index.html");
	await expect(pluginRow(page, "A Shared companion").locator("kbd")).toHaveText(
		["Ctrl", "Alt", "A"]
	);
	await settled(request);
	const before = await control(request);
	await control(request, { holdWrite: true });
	await record(page, "A Shared companion", "Control+Alt+R");
	await expect.poll(async () => (await control(request)).held.length).toBe(1);
	const held = await control(request);
	expect(entryWrites(held)).toHaveLength(1);
	expect(entryWrites(held)[0]).toMatchObject({
		authority: "a",
		admitted: false,
		completed: false,
	});
	await selectAuthority(page, ["b", "a"]);
	await control(request, { releaseIds: held.held.map((item) => item.id) });
	await settled(request);
	await twoFrames(page);
	const landed = await control(request);
	expect(entryWrites(landed)).toHaveLength(1);
	expect(entryWrites(landed)[0]).toMatchObject({
		authority: "a",
		authorization: "Bearer plugin-token-a",
		entry: { entry: "plugin:proof-shared", value: "CommandOrControl+Alt+R" },
		admitted: true,
		status: 200,
	});
	expect(landed.disk).toEqual({
		a: { ...before.disk.a, "plugin:proof-shared": "CommandOrControl+Alt+R" },
		b: before.disk.b,
	});
	await expect(pluginRow(page, "A Shared companion").locator("kbd")).toHaveText(
		["Ctrl", "Alt", "A"]
	);
	await expect(pluginRow(page, "B Shared companion")).not.toBeVisible();
	await record(page, "A Shared companion", "Control+Alt+C");
	await expect
		.poll(
			async () =>
				entryWrites(await control(request)).filter(
					(c) => c.admitted && c.completed
				).length
		)
		.toBe(2);
	const saved = await control(request);
	expect(entryWrites(saved)).toHaveLength(2);
	expect(entryWrites(saved)[1]).toMatchObject({
		authority: "a",
		authorization: "Bearer plugin-token-a",
		entry: { entry: "plugin:proof-shared", value: "CommandOrControl+Alt+C" },
		document: {
			...before.disk.a,
			"plugin:proof-shared": "CommandOrControl+Alt+C",
		},
	});
	expect(saved.disk.b).toEqual(before.disk.b);
	await expect(pluginRow(page, "A Shared companion").locator("kbd")).toHaveText(
		["Ctrl", "Alt", "C"]
	);
	await page.reload();
	await expect(pluginRow(page, "A Shared companion").locator("kbd")).toHaveText(
		["Ctrl", "Alt", "C"]
	);
	expect((await control(request)).disk).toEqual(saved.disk);
});

test("a disabled plugin's shortcut is withheld from editing while its saved override survives another plugin's real chord; re-enabling restores it", async ({
	page,
	request,
}) => {
	await control(request, { disabledIds: ["proof-a-only"] });
	await page.goto("/index.html");
	const shared = pluginRow(page, "A Shared companion");
	await expect(shared.locator("kbd")).toHaveText(["Ctrl", "Alt", "A"]);
	// Core reports the plugin installed but disabled: no row, recorder or Reset
	// may target it (every plugin row names its plugin id).
	await expect(pluginRow(page, "proof-shared")).toHaveCount(1);
	await expect(pluginRow(page, "proof-a-only")).toHaveCount(0);
	await settled(request);
	const before = await control(request);
	expect(before.disk.a["plugin:proof-a-only"]).toBe("Control+Alt+X");
	await record(page, "A Shared companion", "Control+Alt+C");
	await expect
		.poll(
			async () =>
				entryWrites(await control(request)).filter(
					(c) => c.admitted && c.completed
				).length
		)
		.toBe(1);
	const saved = await control(request);
	expect(entryWrites(saved)).toHaveLength(1);
	expect(entryWrites(saved)[0]).toMatchObject({
		authority: "a",
		authorization: "Bearer plugin-token-a",
		entry: { entry: "plugin:proof-shared", value: "CommandOrControl+Alt+C" },
		status: 200,
		admitted: true,
		document: {
			...before.disk.a,
			"plugin:proof-shared": "CommandOrControl+Alt+C",
		},
	});
	// The disabled plugin's saved chord is conserved byte-for-value.
	expect(saved.disk.a).toEqual({
		...before.disk.a,
		"plugin:proof-shared": "CommandOrControl+Alt+C",
	});
	expect(saved.disk.b).toEqual(before.disk.b);
	await expect(shared.locator("kbd")).toHaveText(["Ctrl", "Alt", "C"]);

	await control(request, { disabledIds: [] });
	await page.reload();
	await expect(pluginRow(page, "proof-a-only")).toHaveCount(1);
	await expect(
		pluginRow(page, "A Unrelated companion").locator("kbd")
	).toHaveText(["Ctrl", "Alt", "X"]);
	await expect(shared.locator("kbd")).toHaveText(["Ctrl", "Alt", "C"]);
	expect((await control(request)).disk).toEqual(saved.disk);
});
