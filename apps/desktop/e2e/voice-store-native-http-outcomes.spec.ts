import { expect, test } from "@playwright/test";
const base = "http://127.0.0.1:5866";
async function control(body?: unknown) {
	const response = await fetch(base + "/control", {
		method: body ? "POST" : "GET",
		headers: {
			"x-fixture-control": "local-voice-outcomes-control",
			"content-type": "application/json",
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	expect(response.status).toBe(200);
	return await response.json();
}
async function modelRow(page: import("@playwright/test").Page, name: string) {
	// Actual production SettingsItem row containing this unique model title and its action.
	const title = page.getByText(name, { exact: true });
	await expect(title).toBeVisible();
	return title.locator(
		'xpath=ancestor::*[.//button or .//span[text()="Installed"]][1]',
	);
}
const evidence = new WeakMap<
	object,
	{
		unexpectedOrigins: string[];
		pageErrors: string[];
		consoleErrors: { text: string; url: string }[];
		iconMetadataFixture: {
			method: string;
			url: string;
			status: number;
			body: string;
		}[];
	}
>();
test.beforeEach(async ({ page }) => {
	await control({ reset: true });
	const recorded = {
		unexpectedOrigins: [] as string[],
		pageErrors: [] as string[],
		consoleErrors: [] as { text: string; url: string }[],
		iconMetadataFixture: [] as {
			method: string;
			url: string;
			status: number;
			body: string;
		}[],
	};
	evidence.set(page, recorded);
	page.on("pageerror", (error) => recorded.pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error")
			recorded.consoleErrors.push({
				text: message.text(),
				url: message.location().url,
			});
	});
	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		// Decorative brand-index metadata only; never intercept any native voice/SDK response.
		if (
			url.href === "https://api.svgl.app/" &&
			route.request().method() === "GET" &&
			recorded.iconMetadataFixture.length < 4
		) {
			recorded.iconMetadataFixture.push({
				method: "GET",
				url: url.href,
				status: 200,
				body: "[]",
			});
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: "[]",
			});
			return;
		}
		if (
			["http:", "https:"].includes(url.protocol) &&
			!["http://127.0.0.1:5291", "http://127.0.0.1:5866"].includes(url.origin)
		) {
			recorded.unexpectedOrigins.push(url.href);
			await route.abort();
			return;
		}
		await route.continue();
	});
});
test.afterEach(async ({ page }, testInfo) => {
	// Release only this owned finite fixture; never alter the test verdict or discard its ledger.
	await control({ release: true });
	await expect
		.poll(async () => {
			const r = await control();
			return r.held === 0 && r.calls.every((c: any) => c.finished === true);
		})
		.toBe(true);
	await page.close();
	const receipt = await control();
	const recorded = evidence.get(page)!;
	const unexpectedConsole = recorded.consoleErrors.filter((error) => {
		if (!/Failed to load resource:.*503/.test(error.text)) return true;
		try {
			const url = new URL(error.url);
			return (
				url.origin !== base ||
				!receipt.calls.some(
					(c: any) => c.path === url.pathname && c.status === 503,
				)
			);
		} catch {
			return true;
		}
	});
	const ledger = {
		calls: receipt.calls,
		disk: receipt.disk,
		held: receipt.held,
		unexpected: [
			...recorded.unexpectedOrigins,
			...receipt.calls.filter(
				(c: any) => c.authorizationAccepted !== true || c.status === 404,
			),
		],
		browserErrors: [...recorded.pageErrors, ...unexpectedConsole],
		iconMetadataFixture: recorded.iconMetadataFixture,
		boundary:
			"Actual authenticated native voice HTTP and separately inspected fixture disk; exact GET https://api.svgl.app/ decorative brand-index metadata is a bounded empty-array fixture only; no live SVGL/icon availability proof or genuine Core/download/model/process/OS proof",
	};
	await testInfo.attach("voice-native-http-ledger", {
		body: Buffer.from(JSON.stringify(ledger, null, 2)),
		contentType: "application/json",
	});
	try {
		expect(ledger.unexpected).toEqual([]);
		expect(ledger.browserErrors).toEqual([]);
		expect(ledger.held).toBe(0);
		expect(ledger.calls.every((c: any) => c.finished === true)).toBe(true);
	} finally {
		// Reset only after preserving actual outcomes, including failed assertions and released held operations.
		await control({ reset: true });
	}
});

const runningSwitch = (page: import("@playwright/test").Page) =>
	page.getByRole("switch", {
		name: "Start or stop Ryu Audio engine",
		exact: true,
	});
const mutations = (r: any) => r.calls.filter((c: any) => c.method === "POST");
const commands = (r: any) =>
	mutations(r).map((c: any) => ({
		authority: c.authority,
		path: c.path,
		body: c.body,
		authorized: c.authorizationAccepted,
	}));
async function paint(page: import("@playwright/test").Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
}

test("Store confirmed running stop persists stopped and survives fresh document without another mutation", async ({
	page,
}) => {
	await control({ setState: { runtimeRunning: true } });
	await page.goto("/voice-store-native-http-outcomes.html");
	await expect(runningSwitch(page)).toBeChecked();
	await runningSwitch(page).click();
	await expect(runningSwitch(page)).not.toBeChecked();
	await expect(runningSwitch(page)).toBeEnabled();
	const r = await control();
	expect(r.disk.runtimeRunning).toBe(false);
	expect(commands(r)).toEqual([
		{
			authority: "a",
			path: "/api/sidecar/ryutts/stop",
			body: null,
			authorized: true,
		},
	]);
	const stop = r.calls.findIndex(
		(c: any) =>
			c.path === "/api/sidecar/ryutts/stop" && c.responseBody?.success === true,
	);
	expect(stop).toBeGreaterThanOrEqual(0);
	expect(
		r.calls
			.slice(stop + 1)
			.some(
				(c: any) =>
					c.path === "/api/sidecar/status" &&
					c.finished &&
					c.responseBody?.sidecars.some(
						(v: any) => v.name === "ryutts" && !v.running,
					),
			),
	).toBe(true);
	await page.reload();
	await expect(runningSwitch(page)).not.toBeChecked();
	expect(mutations(await control())).toHaveLength(1);
});

test("Store refused restart stop cannot execute start and explicit retry completes stop readback then start", async ({
	page,
}) => {
	await control({ setState: { runtimeRunning: true }, refuseStop: 1 });
	await page.goto("/voice-store-native-http-outcomes.html");
	await page.getByRole("button", { name: "Restart", exact: true }).click();
	await expect(
		page
			.getByRole("dialog")
			.getByText("Finite runtime stop refused", { exact: true }),
	).toBeVisible();
	await expect(runningSwitch(page)).toBeChecked();
	await expect(
		page.getByRole("button", { name: "Restart", exact: true }),
	).toBeEnabled();
	let r = await control();
	expect(r.disk.runtimeRunning).toBe(true);
	expect(mutations(r).map((c: any) => c.path)).toEqual([
		"/api/sidecar/ryutts/stop",
	]);
	await page.getByRole("button", { name: "Restart", exact: true }).click();
	await expect.poll(async () => mutations(await control()).length).toBe(3);
	await expect(runningSwitch(page)).toBeChecked();
	await expect(runningSwitch(page)).toBeEnabled();
	r = await control();
	expect(r.disk.runtimeRunning).toBe(true);
	expect(
		mutations(r).map((c: any) => [c.path, c.body, c.authorizationAccepted]),
	).toEqual([
		["/api/sidecar/ryutts/stop", null, true],
		["/api/sidecar/ryutts/stop", null, true],
		["/api/sidecar/ryutts/start", null, true],
	]);
	const successfulStop = r.calls.findIndex(
		(c: any) =>
			c.path === "/api/sidecar/ryutts/stop" && c.responseBody?.success === true,
	);
	const start = r.calls.findIndex(
		(c: any) => c.path === "/api/sidecar/ryutts/start",
	);
	expect(
		r.calls
			.slice(successfulStop + 1, start)
			.some(
				(c: any) =>
					c.path === "/api/sidecar/status" &&
					c.responseBody?.sidecars.some(
						(s: any) => s.name === "ryutts" && !s.running,
					) &&
					c.finished,
			),
	).toBe(true);
});

test("Store unreadable runtime health denies mutation and actual Refresh all recovers read only", async ({
	page,
}) => {
	await control({ setState: { runtimeRunning: true }, failStatusRead: 100 });
	await page.goto("/voice-store-native-http-outcomes.html");
	await expect(
		page.getByRole("dialog").getByText("Status unknown", { exact: true }),
	).toBeVisible();
	await expect(runningSwitch(page)).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Restart", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Remove", exact: true }),
	).toHaveCount(0);
	expect(mutations(await control())).toEqual([]);
	expect((await control()).disk.runtimeRunning).toBe(true);
	await control({ failStatusRead: 0 });
	await page.evaluate(() =>
		(window as any).__voiceOutcomeAuthority.refreshAll(),
	);
	await expect(runningSwitch(page)).toBeChecked();
	await expect(runningSwitch(page)).toBeEnabled();
	expect(mutations(await control())).toEqual([]);
	expect((await control()).disk.runtimeRunning).toBe(true);
});

test("Store confirmed stopped uninstall persists removal and fresh catalog cannot claim installed", async ({
	page,
}) => {
	await page.goto("/voice-store-native-http-outcomes.html");
	await expect(runningSwitch(page)).not.toBeChecked();
	await page.getByRole("button", { name: "Remove", exact: true }).click();
	await expect
		.poll(async () => (await control()).disk.runtimeInstalled)
		.toBe(false);
	await expect(runningSwitch(page)).toBeDisabled();
	expect(commands(await control())).toEqual([
		{
			authority: "a",
			path: "/api/setup/ryutts/uninstall",
			body: null,
			authorized: true,
		},
	]);
	await page.reload();
	await expect(runningSwitch(page)).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Remove", exact: true }),
	).toHaveCount(0);
	expect(mutations(await control())).toHaveLength(1);
});

test("Store retired stop refusal cannot paint new authority or clear its held start pending state", async ({
	page,
}, testInfo) => {
	try {
		await control({
			setState: { runtimeRunning: true },
			refuseStop: 1,
			holdStop: 1,
		});
		await page.goto("/voice-store-native-http-outcomes.html");
		await runningSwitch(page).click();
		await expect.poll(async () => (await control()).held).toBe(1);
		await control({ authority: "b", holdStart: 1 });
		await page.evaluate(() =>
			(window as any).__voiceOutcomeAuthority.select("b"),
		);
		await expect(runningSwitch(page)).toBeEnabled();
		await expect(runningSwitch(page)).not.toBeChecked();
		await runningSwitch(page).click();
		await expect.poll(async () => (await control()).held).toBe(2);
		const before = await control();
		const aHeld = before.heldReceipts.find((h: any) => h.authority === "a");
		const response = page.waitForResponse(
			(r) =>
				r.url() === "http://127.0.0.1:5866/api/sidecar/ryutts/stop" &&
				r.request().method() === "POST",
		);
		await control({ release: true, id: aHeld.id });
		await (await response).finished();
		await paint(page);
		await expect(
			page
				.getByRole("dialog")
				.getByText("Finite runtime stop refused", { exact: true }),
		).toHaveCount(0);
		await expect(runningSwitch(page)).toBeDisabled();
		expect((await control()).authorities.b.disk.runtimeRunning).toBe(false);
		await control({ release: true });
		await expect(runningSwitch(page)).toBeChecked();
		await expect(runningSwitch(page)).toBeEnabled();
		const r = await control();
		expect(r.authorities.a.disk.runtimeRunning).toBe(true);
		expect(r.authorities.b.disk.runtimeRunning).toBe(true);
		expect(r.authorities.rotated.disk.runtimeRunning).toBe(false);
		expect(commands(r)).toEqual([
			{
				authority: "a",
				path: "/api/sidecar/ryutts/stop",
				body: null,
				authorized: true,
			},
			{
				authority: "b",
				path: "/api/sidecar/ryutts/start",
				body: null,
				authorized: true,
			},
		]);
	} finally {
		const r = await control();
		await testInfo.attach("voice-authority-native-ledger", {
			body: Buffer.from(
				JSON.stringify({
					calls: r.calls,
					authorities: r.authorities,
					held: r.held,
					heldReceipts: r.heldReceipts,
				}),
			),
			contentType: "application/json",
		});
	}
});

test("Store confirmed running hero must stop claiming live after unreadable health and recover without mutation", async ({
	page,
}) => {
	await control({ setState: { runtimeRunning: true } });
	await page.goto("/voice-store-native-http-outcomes.html");
	await expect(runningSwitch(page)).toBeChecked();
	await expect(
		page.getByRole("img", { name: "Running", exact: true }).first(),
	).toBeVisible();
	await expect
		.poll(
			async () =>
				(await control()).calls.filter(
					(c: any) =>
						c.path === "/api/sidecar/status" && c.finished && c.status === 200,
				).length,
		)
		.toBeGreaterThanOrEqual(2);
	await control({ failStatusRead: 100 });
	await page.evaluate(() =>
		(window as any).__voiceOutcomeAuthority.refreshAll(),
	);
	await expect(runningSwitch(page)).toBeDisabled();
	await expect(
		page.getByRole("dialog").getByText("Status unknown", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("dialog").getByText("Unknown", { exact: true }).first(),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Restart", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Remove", exact: true }),
	).toHaveCount(0);
	// Actual accessible StatusBadge across list and hero must not imply a live process.
	await expect(
		page.getByRole("img", { name: "Running", exact: true }),
	).toHaveCount(0);
	const unreadable = await control();
	expect(unreadable.disk.runtimeRunning).toBe(true);
	expect(mutations(unreadable)).toEqual([]);
	await control({ failStatusRead: 0 });
	await page.evaluate(() =>
		(window as any).__voiceOutcomeAuthority.refreshAll(),
	);
	await expect(runningSwitch(page)).toBeChecked();
	await expect(runningSwitch(page)).toBeEnabled();
	await expect(
		page.getByRole("img", { name: "Running", exact: true }).first(),
	).toBeVisible();
	expect(mutations(await control())).toEqual([]);
	expect((await control()).disk.runtimeRunning).toBe(true);
});
