import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";

const HOST = "http://127.0.0.1:33367";
type Document = Record<string, string | null>;
interface Call {
	admitted: boolean;
	authority: string;
	authorization: string | null;
	buyerToken: string | null;
	completed: boolean;
	contentType: string | null;
	delegation: string | null;
	document?: Document;
	endpoint: string;
	id: number;
	method: string;
	preferenceValue?: string | null;
	query: string;
	rawBody: string;
	status: number;
}
interface Receipt {
	calls: Call[];
	disk: { a: Document; b: Document };
	held: Array<{ id: number }>;
	rawDisk: {
		a: { bytes: string; sha256: string };
		b: { bytes: string; sha256: string };
	};
	unexpectedNative: string[];
}
const errors = new WeakMap<Page, string[]>();
const consoles = new WeakMap<Page, string[]>();
const unexpected = new WeakMap<Page, string[]>();
async function control(
	request: APIRequestContext,
	body?: unknown
): Promise<Receipt> {
	const response =
		body === undefined
			? await request.get(`${HOST}/control`, {
					headers: { "x-fixture-control": "plugin-control" },
				})
			: await request.post(`${HOST}/control`, {
					headers: { "x-fixture-control": "plugin-control" },
					data: body,
				});
	expect(response.ok()).toBe(true);
	return response.json();
}
async function settled(request: APIRequestContext) {
	await expect
		.poll(async () => {
			const state = await control(request);
			return (
				state.held.length === 0 && state.calls.every((call) => call.completed)
			);
		})
		.toBe(true);
}
const pluginRow = (page: Page, label: string) =>
	page
		.locator('[data-slot="item"]')
		.filter({ has: page.getByText(label, { exact: true }) });
async function record(page: Page, label: string, chord: string) {
	const row = pluginRow(page, label);
	await expect(row).toHaveCount(1);
	const recorder = row.locator("button").filter({ has: page.locator("kbd") });
	await expect(recorder).toHaveCount(1);
	await recorder.click();
	await expect(row.getByText("Press keys…", { exact: true })).toBeVisible();
	await page.keyboard.press(chord);
}
test.beforeEach(async ({ page, request }) => {
	await control(request, { reset: true });
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	const network: string[] = [];
	errors.set(page, pageErrors);
	consoles.set(page, consoleErrors);
	unexpected.set(page, network);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (
			["http://127.0.0.1:33367", "http://127.0.0.1:33368"].includes(url.origin)
		) {
			await route.continue();
			return;
		}
		network.push(`${route.request().method()} ${url.href}`);
		await route.abort();
	});
});
test.afterEach(async ({ page, request }, info) => {
	try {
		await control(request, { release: true });
		await settled(request);
		await page.close();
		await settled(request);
		const receipt = await control(request);
		expect(receipt.unexpectedNative).toEqual([]);
		for (const call of receipt.calls) {
			expect(call).toMatchObject({
				delegation: null,
				buyerToken: null,
				contentType: "application/json",
				query: "",
				completed: true,
			});
			if (call.method === "GET") {
				expect(call.rawBody).toBe("");
			}
		}
		expect(errors.get(page) ?? []).toEqual([]);
		expect(unexpected.get(page) ?? []).toEqual([]);
	} finally {
		let native: Receipt | { diagnosticError: string };
		try {
			native = await control(request);
		} catch (error) {
			native = { diagnosticError: String(error) };
		}
		await info.attach("plugin-native-authority-ledger", {
			body: JSON.stringify({
				native,
				browserErrors: errors.get(page) ?? [],
				consoleErrors: consoles.get(page) ?? [],
				unexpectedRequests: unexpected.get(page) ?? [],
			}),
			contentType: "application/json",
		});
	}
});
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
				(await control(request)).calls.filter(
					(call) => call.method === "PUT" && call.completed && call.admitted
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
	const write = receipt.calls.filter((call) => call.method === "PUT");
	expect(write).toHaveLength(1);
	expect(write[0]).toMatchObject({
		authority: "b",
		authorization: "Bearer plugin-token-b",
		endpoint: "/api/preferences/keybindings",
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
			response.url() === `${HOST}/b/api/preferences/keybindings` &&
			response.request().method() === "PUT" &&
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
				(await control(request)).calls.filter(
					(call) =>
						call.method === "PUT" && call.completed && call.status === 503
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
				(await control(request)).calls.filter(
					(call) => call.method === "PUT" && call.completed && call.admitted
				).length
		)
		.toBe(1);
	const receipt = await control(request);
	const writes = receipt.calls.filter((call) => call.method === "PUT");
	expect(writes).toHaveLength(2);
	expect(
		writes.map((call) => ({
			authority: call.authority,
			status: call.status,
			admitted: call.admitted,
			authorization: call.authorization,
		}))
	).toEqual([
		{
			authority: "b",
			status: 503,
			admitted: false,
			authorization: "Bearer plugin-token-b",
		},
		{
			authority: "b",
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
const puts = (receipt: Receipt) =>
	receipt.calls.filter((call) => call.method === "PUT");
async function twoFrames(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
}
async function selectAuthority(page: Page, keys: Array<"a" | "b">) {
	await page.evaluate((keys) => {
		for (const key of keys) {
			(
				window as unknown as {
					__PLUGIN_AUTHORITY__: { select: (key: "a" | "b") => void };
				}
			).__PLUGIN_AUTHORITY__.select(key);
		}
	}, keys);
}

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
			r.url() === `${HOST}/a/api/preferences/keybindings` &&
			r.request().method() === "PUT" &&
			r.status() === 503
	);
	await row.getByRole("button", { name: "Reset", exact: true }).click();
	await (await refused).finished();
	await settled(request);
	await twoFrames(page);
	const retained = await control(request);
	const { "plugin:proof-shared": _removed, ...expected } = seeded;
	expect(puts(retained)).toHaveLength(1);
	expect(puts(retained)[0]).toMatchObject({
		authority: "a",
		status: 503,
		admitted: false,
		completed: true,
		document: expected,
	});
	expect(retained.disk).toEqual(before.disk);
	expect(retained.rawDisk).toEqual(before.rawDisk);
	await expect(row.locator("kbd")).toHaveText(["Ctrl", "Alt", "A"]);
	await control(request, { refuseWrite: false });
	await row.getByRole("button", { name: "Reset", exact: true }).click();
	await expect
		.poll(
			async () =>
				puts(await control(request)).filter((c) => c.admitted && c.completed)
					.length
		)
		.toBe(1);
	const saved = await control(request);
	expect(puts(saved)).toHaveLength(2);
	expect(puts(saved)[1]).toMatchObject({
		authority: "a",
		authorization: "Bearer plugin-token-a",
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

test("malformed native documents disable editing and never PUT; repaired full document loads only through explicit Retry", async ({
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
		expect(puts(refused)).toHaveLength(0);
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
				puts(await control(request)).filter((c) => c.admitted && c.completed)
					.length
		)
		.toBe(1);
	const saved = await control(request);
	expect(saved.disk.a).toEqual({
		...repaired,
		"plugin:proof-shared": "CommandOrControl+Alt+R",
	});
	expect(puts(saved)).toHaveLength(1);
	expect(saved.disk.b).toEqual(beforeRetry.disk.b);
	await page.reload();
	await expect(row.locator("kbd")).toHaveText(["Ctrl", "Alt", "R"]);
	expect((await control(request)).disk).toEqual(saved.disk);
	// A valid initial load cannot authorize replacing later externally corrupted data.
	const stable = await control(request);
	const invalid = '{"plugin:proof-shared":42}';
	for (const action of ["record", "reset"] as const) {
		await settled(request);
		await control(request, { rawDocument: { authority: "a", bytes: invalid } });
		const beforeWrite = await control(request);
		const oldPuts = puts(beforeWrite).length;
		const corruptResponse = page.waitForResponse(
			(response) =>
				response.url() === `${HOST}/a/api/preferences/keybindings` &&
				response.request().method() === "GET"
		);
		if (action === "record") {
			await record(page, "A Shared companion", "Control+Alt+Z");
		} else {
			await row.getByRole("button", { name: "Reset", exact: true }).click();
		}
		const observedCorrupt = await corruptResponse;
		await observedCorrupt.finished();
		expect((await observedCorrupt.json()).value).toBe(invalid);
		await settled(request);
		await expect(
			page.getByText("Couldn't update plugin shortcut", { exact: true })
		).toBeVisible();
		await twoFrames(page);
		const blocked = await control(request);
		expect(puts(blocked)).toHaveLength(oldPuts);
		expect(blocked.rawDisk.a.bytes).toBe(invalid);
		expect(blocked.disk.b).toEqual(stable.disk.b);
		const newReads = blocked.calls.filter(
			(call) =>
				call.id > Math.max(0, ...beforeWrite.calls.map((c) => c.id)) &&
				call.authority === "a" &&
				call.endpoint === "/api/preferences/keybindings" &&
				call.method === "GET"
		);
		expect(
			newReads.some(
				(call) => call.preferenceValue === invalid && call.completed
			)
		).toBe(true);
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

test("synchronous A to B to A retires held old write intent; only a fresh current-A chord can change the native document", async ({
	page,
	request,
}) => {
	await page.goto("/index.html");
	await expect(pluginRow(page, "A Shared companion").locator("kbd")).toHaveText(
		["Ctrl", "Alt", "A"]
	);
	await settled(request);
	const before = await control(request);
	await control(request, { holdRead: true });
	await record(page, "A Shared companion", "Control+Alt+R");
	await expect.poll(async () => (await control(request)).held.length).toBe(1);
	const held = await control(request);
	await selectAuthority(page, ["b", "a"]);
	await control(request, { releaseIds: held.held.map((item) => item.id) });
	await settled(request);
	await twoFrames(page);
	const retired = await control(request);
	expect(puts(retired)).toHaveLength(0);
	expect(retired.disk).toEqual(before.disk);
	await expect(pluginRow(page, "A Shared companion").locator("kbd")).toHaveText(
		["Ctrl", "Alt", "A"]
	);
	await expect(pluginRow(page, "B Shared companion")).not.toBeVisible();
	await record(page, "A Shared companion", "Control+Alt+C");
	await expect
		.poll(
			async () =>
				puts(await control(request)).filter((c) => c.admitted && c.completed)
					.length
		)
		.toBe(1);
	const saved = await control(request);
	expect(puts(saved)).toHaveLength(1);
	expect(puts(saved)[0]).toMatchObject({
		authority: "a",
		authorization: "Bearer plugin-token-a",
		document: {
			...before.disk.a,
			"plugin:proof-shared": "CommandOrControl+Alt+C",
		},
	});
	expect(saved.disk.b).toEqual(before.disk.b);
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
				puts(await control(request)).filter((c) => c.admitted && c.completed)
					.length
		)
		.toBe(1);
	const saved = await control(request);
	expect(puts(saved)).toHaveLength(1);
	expect(puts(saved)[0]).toMatchObject({
		authority: "a",
		authorization: "Bearer plugin-token-a",
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
