import { expect, test } from "@playwright/test";
// Preserve the accepted native packet's per-case timeout without changing legacy Voice cases.
test.setTimeout(60_000);
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
	}
>();
test.beforeEach(async ({ page }) => {
	await control({ reset: true });
	const recorded = {
		unexpectedOrigins: [] as string[],
		pageErrors: [] as string[],
		consoleErrors: [] as { text: string; url: string }[],
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
		boundary:
			"Actual authenticated loopback HTTP and separately inspected fixture disk; finite Core DTOs, not genuine Core/download/model/process/OS proof",
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

test("refused model download is visible and retry confirms the exact same model across a fresh document", async ({
	page,
}) => {
	await control({ failModelInstall: 1 });
	await page.goto("/voice-install-native-http-outcomes.html");
	const row = await modelRow(page, "Kokoro finite model");
	await row.getByRole("button", { name: "Install", exact: true }).click();
	await expect
		.poll(
			async () =>
				(await control()).calls.filter(
					(c: any) => c.path === "/api/voice/tts-models/install",
				).length,
		)
		.toBe(1);
	await expect(
		page.getByText(/Finite model download refused|Couldn.t install.*model/),
	).toBeVisible();
	await expect(row.getByText("Installed", { exact: true })).toHaveCount(0);
	expect((await control()).disk.models[0].installed).toBe(false);
	await row.getByRole("button", { name: "Install", exact: true }).click();
	await expect(row.getByText("Installed", { exact: true })).toBeVisible();
	const receipt = await control();
	expect(
		receipt.calls
			.filter((c: any) => c.path === "/api/voice/tts-models/install")
			.map((c: any) => ({
				body: c.body,
				authorizationAccepted: c.authorizationAccepted,
			})),
	).toEqual([
		{
			body: { engine: "kokoro", model_name: "kokoro-finite-model" },
			authorizationAccepted: true,
		},
		{
			body: { engine: "kokoro", model_name: "kokoro-finite-model" },
			authorizationAccepted: true,
		},
	]);
	expect(receipt.disk.models[0].installed).toBe(true);
	await page.reload();
	await expect(
		(await modelRow(page, "Kokoro finite model")).getByText("Installed", {
			exact: true,
		}),
	).toBeVisible();
	expect(
		(await control()).calls.filter(
			(c: any) => c.path === "/api/voice/tts-models/install",
		),
	).toHaveLength(2);
});

test("held download cannot claim Installed or submit another model; acknowledged inventory supplies the outcome", async ({
	page,
}) => {
	await control({ holdModelInstall: true });
	await page.goto("/voice-install-native-http-outcomes.html");
	const first = await modelRow(page, "Kokoro finite model");
	const second = await modelRow(page, "Pocket finite model");
	await first.getByRole("button", { name: "Install", exact: true }).click();
	await expect(
		first.getByRole("button", { name: "Installing…", exact: true }),
	).toBeDisabled();
	await expect(
		second.getByRole("button", { name: "Waiting…", exact: true }),
	).toBeDisabled();
	await expect.poll(async () => (await control()).held).toBe(1);
	expect((await control()).disk.models.map((m: any) => m.installed)).toEqual([
		false,
		false,
	]);
	await expect(first.getByText("Installed", { exact: true })).toHaveCount(0);
	expect(
		(await control()).calls.filter(
			(c: any) => c.path === "/api/voice/tts-models/install",
		),
	).toHaveLength(1);
	await control({ release: true });
	await expect(first.getByText("Installed", { exact: true })).toBeVisible();
	await expect(
		second.getByRole("button", { name: "Install", exact: true }),
	).toBeEnabled();
	const receipt = await control();
	expect(receipt.disk.models.map((m: any) => m.installed)).toEqual([
		true,
		false,
	]);
	expect(
		receipt.calls.filter((c: any) => c.path === "/api/voice/tts-models").length,
	).toBeGreaterThanOrEqual(2);
	await page.reload();
	await expect(
		(await modelRow(page, "Kokoro finite model")).getByText("Installed", {
			exact: true,
		}),
	).toBeVisible();
});

test("failed acknowledged inventory read retains confirmed models and retries GET without downloading twice", async ({
	page,
}) => {
	await page.goto("/voice-install-native-http-outcomes.html");
	const first = await modelRow(page, "Kokoro finite model");
	await first.getByRole("button", { name: "Install", exact: true }).click();
	await expect(first.getByText("Installed", { exact: true })).toBeVisible();
	await control({ failModelsRead: 1 });
	const second = await modelRow(page, "Pocket finite model");
	await second.getByRole("button", { name: "Install", exact: true }).click();
	await expect(
		page.getByText(
			/Couldn.t load.*voice models|Finite model inventory unreadable/,
		),
	).toBeVisible();
	await expect(first.getByText("Installed", { exact: true })).toBeVisible();
	const before = await control();
	expect(before.disk.models.map((m: any) => m.installed)).toEqual([true, true]);
	expect(
		before.calls.filter((c: any) => c.path === "/api/voice/tts-models/install"),
	).toHaveLength(2);
	await page
		.getByRole("button", { name: "Retry loading voice models", exact: true })
		.click();
	await expect(second.getByText("Installed", { exact: true })).toBeVisible();
	expect(
		(await control()).calls.filter(
			(c: any) => c.path === "/api/voice/tts-models/install",
		),
	).toHaveLength(2);
});

test("HTTP200 refused runtime start keeps runtime stopped, exposes failure and retries exactly once", async ({
	page,
}) => {
	await control({ refuseStart: true });
	await page.goto("/voice-install-native-http-outcomes.html");
	const start = page.getByRole("button", {
		name: "Start Ryu Audio engine",
		exact: true,
	});
	await expect(start).toBeVisible();
	await start.click();
	await expect(
		page.getByText(
			/Finite runtime start refused|Couldn.t start.*audio|Couldn.t start.*voice/i,
		),
	).toBeVisible();
	await expect(start).toBeEnabled();
	expect((await control()).disk.runtimeRunning).toBe(false);
	await expect(
		page.getByRole("combobox", { name: "Audio engine" }),
	).toContainText("not installed");
	await control({ refuseStart: false });
	await start.click();
	await expect(start).toHaveCount(0);
	await expect(
		page.getByRole("combobox", { name: "Audio engine" }),
	).not.toContainText("not installed");
	const receipt = await control();
	expect(receipt.disk.runtimeRunning).toBe(true);
	expect(
		receipt.calls
			.filter((c: any) => c.path === "/api/sidecar/ryutts/start")
			.map((c: any) => ({
				method: c.method,
				body: c.body,
				authorizationAccepted: c.authorizationAccepted,
			})),
	).toEqual([
		{ method: "POST", body: null, authorizationAccepted: true },
		{ method: "POST", body: null, authorizationAccepted: true },
	]);
	await page.reload();
	await expect(start).toHaveCount(0);
});

test("unreadable runtime health after start cannot manufacture stopped state or replay a successful start", async ({
	page,
}) => {
	await page.goto("/voice-install-native-http-outcomes.html");
	const start = page.getByRole("button", {
		name: "Start Ryu Audio engine",
		exact: true,
	});
	await expect(start).toBeVisible();
	await control({ failStatusRead: 1 });
	await start.click();
	await expect(
		page.getByText(
			/Couldn.t confirm.*audio|Couldn.t load.*runtime status|Finite runtime status unreadable/i,
		),
	).toBeVisible();
	expect((await control()).disk.runtimeRunning).toBe(true);
	await expect(
		page.getByRole("button", { name: "Start Ryu Audio engine", exact: true }),
	).toHaveCount(0);
	await page
		.getByRole("button", {
			name: "Retry loading voice runtime status",
			exact: true,
		})
		.click();
	await expect(
		page.getByRole("combobox", { name: "Audio engine" }),
	).not.toContainText("not installed");
	expect(
		(await control()).calls.filter(
			(c: any) => c.path === "/api/sidecar/ryutts/start",
		),
	).toHaveLength(1);
});

test("runtime download refusal cannot become installed; retry and fresh health read preserve separate installed/stopped states", async ({
	page,
}) => {
	await control({
		reset: true,
		state: { runtimeInstalled: false },
		controls: { failRuntimeInstall: 1 },
	});
	await page.goto("/voice-install-native-http-outcomes.html");
	const install = page.getByRole("button", {
		name: "Install Ryu Audio engine",
		exact: true,
	});
	await expect(install).toBeVisible();
	await install.click();
	await expect(
		page.getByText(
			/Finite runtime download refused|Couldn.t install.*audio|Couldn.t install.*voice/i,
		),
	).toBeVisible();
	await expect(install).toBeEnabled();
	expect((await control()).disk.runtimeInstalled).toBe(false);
	expect((await control()).disk.runtimeRunning).toBe(false);
	await expect(
		page.getByRole("button", { name: "Start Ryu Audio engine", exact: true }),
	).toHaveCount(0);
	await install.click();
	await expect(
		page.getByRole("button", { name: "Start Ryu Audio engine", exact: true }),
	).toBeVisible();
	const receipt = await control();
	expect(receipt.disk.runtimeInstalled).toBe(true);
	expect(receipt.disk.runtimeRunning).toBe(false);
	expect(
		receipt.calls.filter((c: any) => c.path === "/api/setup/ryutts/install"),
	).toHaveLength(2);
	expect(
		receipt.calls.filter((c: any) => c.path === "/api/sidecar/ryutts/start"),
	).toHaveLength(0);
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Start Ryu Audio engine", exact: true }),
	).toBeVisible();
	await expect(install).toHaveCount(0);
});

async function releaseAndObserve(
	page: import("@playwright/test").Page,
	id: number,
	rawPath: string,
) {
	const responsePromise = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === rawPath &&
			response.request().method() === "GET",
	);
	await control({ release: true, id });
	const response = await responsePromise;
	await response.finished();
	// Let the resolved body promise and React publish across actual browser frames, not a timed sleep.
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
}

test("synchronous real node ABA retires the held original inventory before React commits", async ({
	page,
}, testInfo) => {
	try {
		await control({ holdModelsRead: 1 });
		await page.goto("/voice-install-native-http-outcomes.html");
		await expect(
			page.getByRole("combobox", { name: "Audio engine" }),
		).toBeVisible();
		await expect
			.poll(
				async () =>
					(await control()).heldReceipts.filter(
						(h: any) =>
							h.authority === "a" && h.path === "/api/voice/tts-models",
					).length,
			)
			.toBe(1);
		const original = await control();
		const heldRead = original.heldReceipts.find(
			(h: any) => h.authority === "a" && h.path === "/api/voice/tts-models",
		);
		expect(
			original.calls.find(
				(c: any) => c.authority === "a" && c.path === "/api/voice/tts-models",
			).admittedSnapshot.data[0].installed,
		).toBe(false);
		const latest = original.disk.models.map((m: any, index: number) => ({
			...m,
			installed: index === 0,
		}));
		await control({ setState: { models: latest } });
		await page.evaluate(() => {
			const real = (window as any).__voiceOutcomeAuthority;
			real.select("b");
			real.select("a");
		});
		await expect
			.poll(
				async () =>
					(await control()).calls.filter(
						(c: any) =>
							c.authority === "a" && c.path === "/api/voice/tts-models",
					).length,
			)
			.toBe(2);
		const row = await modelRow(page, "Kokoro finite model");
		await expect(row.getByText("Installed", { exact: true })).toBeVisible();
		await releaseAndObserve(page, heldRead.id, "/api/voice/tts-models");
		await expect(row.getByText("Installed", { exact: true })).toBeVisible();
		await expect(
			row.getByRole("button", { name: "Install", exact: true }),
		).toHaveCount(0);
		const receipt = await control();
		expect(
			receipt.calls.filter(
				(c: any) => c.path === "/api/voice/tts-models/install",
			),
		).toHaveLength(0);
		expect(receipt.authorities.a.disk.models[0].installed).toBe(true);
	} finally {
		const authoritySnapshot = await control();
		await testInfo.attach("voice-authority-native-ledger", {
			body: Buffer.from(
				JSON.stringify(
					{
						calls: authoritySnapshot.calls,
						authorities: authoritySnapshot.authorities,
						held: authoritySnapshot.held,
						heldReceipts: authoritySnapshot.heldReceipts,
					},
					null,
					2,
				),
			),
			contentType: "application/json",
		});
	}
});

test("accepted old model acknowledgment cannot refresh or mutate the rotated bearer or newly selected node", async ({
	page,
}, testInfo) => {
	try {
		await control({ holdAcceptedModelAck: 1 });
		await page.goto("/voice-install-native-http-outcomes.html");
		const row = await modelRow(page, "Kokoro finite model");
		await row.getByRole("button", { name: "Install", exact: true }).click();
		await expect
			.poll(
				async () =>
					(await control()).heldReceipts.filter(
						(h: any) =>
							h.authority === "a" && h.path === "/api/voice/tts-models/install",
					).length,
			)
			.toBe(1);
		const admitted = await control();
		expect(admitted.authorities.a.disk.models[0].installed).toBe(true);
		const heldAck = admitted.heldReceipts.find(
			(h: any) =>
				h.authority === "a" && h.path === "/api/voice/tts-models/install",
		);
		const oldReads = admitted.calls.filter(
			(c: any) => c.authority === "a" && c.path === "/api/voice/tts-models",
		).length;
		await page.evaluate(() =>
			(window as any).__voiceOutcomeAuthority.select("rotated"),
		);
		await expect
			.poll(
				async () =>
					(await control()).calls.filter(
						(c: any) =>
							c.authority === "rotated" &&
							c.path === "/api/voice/tts-models" &&
							c.finished,
					).length,
			)
			.toBe(1);
		expect(
			await page.evaluate(
				() => (window as any).__voiceOutcomeAuthority.current().url,
			),
		).toBe("http://127.0.0.1:5866");
		expect(
			await page.evaluate(
				() => (window as any).__voiceOutcomeAuthority.current().token,
			),
		).toBe("finite-voice-outcomes-token-rotated");
		await page.evaluate(() =>
			(window as any).__voiceOutcomeAuthority.select("b"),
		);
		await expect
			.poll(
				async () =>
					(await control()).calls.filter(
						(c: any) =>
							c.authority === "b" &&
							c.path === "/api/voice/tts-models" &&
							c.finished,
					).length,
			)
			.toBe(1);
		await expect(row.getByText("Installed", { exact: true })).toHaveCount(0);
		const responsePromise = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === "/api/voice/tts-models/install" &&
				response.request().method() === "POST",
		);
		await control({ release: true, id: heldAck.id });
		const response = await responsePromise;
		await response.finished();
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				),
		);
		const receipt = await control();
		expect(
			receipt.calls.filter(
				(c: any) => c.authority === "a" && c.path === "/api/voice/tts-models",
			),
		).toHaveLength(oldReads);
		expect(
			receipt.calls
				.filter((c: any) => c.path === "/api/voice/tts-models/install")
				.map((c: any) => ({ authority: c.authority, body: c.body })),
		).toEqual([
			{
				authority: "a",
				body: { engine: "kokoro", model_name: "kokoro-finite-model" },
			},
		]);
		expect(receipt.authorities.a.disk.models[0].installed).toBe(true);
		expect(receipt.authorities.rotated.disk.models[0].installed).toBe(false);
		expect(receipt.authorities.b.disk.models[0].installed).toBe(false);
		await expect(row.getByText("Installed", { exact: true })).toHaveCount(0);
		await expect(
			row.getByRole("button", { name: "Install", exact: true }),
		).toBeEnabled();
	} finally {
		const authoritySnapshot = await control();
		await testInfo.attach("voice-authority-native-ledger", {
			body: Buffer.from(
				JSON.stringify(
					{
						calls: authoritySnapshot.calls,
						authorities: authoritySnapshot.authorities,
						held: authoritySnapshot.held,
						heldReceipts: authoritySnapshot.heldReceipts,
					},
					null,
					2,
				),
			),
			contentType: "application/json",
		});
	}
});

test("a later same-authority health read wins after actual Refresh all while the earlier response is held", async ({
	page,
}, testInfo) => {
	try {
		await control({ holdStatusRead: 1 });
		await page.goto("/voice-install-native-http-outcomes.html");
		await expect(
			page.getByRole("combobox", { name: "Audio engine" }),
		).toBeVisible();
		await expect
			.poll(
				async () =>
					(await control()).heldReceipts.filter(
						(h: any) => h.authority === "a" && h.path === "/api/sidecar/status",
					).length,
			)
			.toBe(1);
		const original = await control();
		const earlier = original.heldReceipts.find(
			(h: any) => h.authority === "a" && h.path === "/api/sidecar/status",
		);
		expect(
			original.calls.find(
				(c: any) => c.authority === "a" && c.path === "/api/sidecar/status",
			).admittedSnapshot.sidecars[0].running,
		).toBe(false);
		await control({ setState: { runtimeRunning: true } });
		await page.evaluate(() =>
			(window as any).__voiceOutcomeAuthority.refreshAll(),
		);
		await expect
			.poll(
				async () =>
					(await control()).calls.filter(
						(c: any) =>
							c.authority === "a" &&
							c.path === "/api/sidecar/status" &&
							c.finished,
					).length,
			)
			.toBe(1);
		await expect(
			page.getByRole("button", { name: "Start Ryu Audio engine", exact: true }),
		).toHaveCount(0);
		await releaseAndObserve(page, earlier.id, "/api/sidecar/status");
		await expect(
			page.getByRole("button", { name: "Start Ryu Audio engine", exact: true }),
		).toHaveCount(0);
		const receipt = await control();
		expect(receipt.authorities.a.disk.runtimeRunning).toBe(true);
		expect(
			receipt.calls
				.filter(
					(c: any) => c.authority === "a" && c.path === "/api/sidecar/status",
				)
				.map((c: any) => c.responseBody.sidecars[0].running),
		).toEqual([false, true]);
		expect(
			receipt.calls.filter((c: any) => c.path === "/api/sidecar/ryutts/start"),
		).toHaveLength(0);
	} finally {
		const authoritySnapshot = await control();
		await testInfo.attach("voice-authority-native-ledger", {
			body: Buffer.from(
				JSON.stringify(
					{
						calls: authoritySnapshot.calls,
						authorities: authoritySnapshot.authorities,
						held: authoritySnapshot.held,
						heldReceipts: authoritySnapshot.heldReceipts,
					},
					null,
					2,
				),
			),
			contentType: "application/json",
		});
	}
});
