import { expect, test } from "@playwright/test";

interface PublisherReceipt {
	calls: Array<{
		id: number;
		method: string;
		path: string;
		authorization: string | null;
		status: number;
		admitted: boolean;
		completed: boolean;
		payload?: {
			lightPreset: string;
			darkPreset: string;
			customThemes: unknown[];
		};
	}>;
	preference: {
		lightPreset: string;
		darkPreset: string;
		customThemes: unknown[];
	} | null;
}
async function publisherControl(
	request: import("@playwright/test").APIRequestContext,
	reset = false
): Promise<PublisherReceipt> {
	const url = "http://127.0.0.1:33364/__appearance-publisher/control";
	const headers = { "x-fixture-control": "appearance-publisher-control" };
	const response = reset
		? await request.post(url, { headers, data: { reset: true } })
		: await request.get(url, { headers });
	expect(response.ok()).toBe(true);
	return response.json();
}
const writes = new WeakMap<
	import("@playwright/test").Page,
	Array<{ key: string; value: string; refused: boolean }>
>();
const unexpectedRequests = new WeakMap<
	import("@playwright/test").Page,
	string[]
>();
const consoleErrors = new WeakMap<import("@playwright/test").Page, string[]>();
const browserErrors = new WeakMap<import("@playwright/test").Page, string[]>();
test.beforeEach(async ({ page, request }) => {
	await publisherControl(request, true);
	const unexpected: string[] = [];
	unexpectedRequests.set(page, unexpected);
	const consoles: string[] = [];
	consoleErrors.set(page, consoles);
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoles.push(message.text());
		}
	});
	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.origin === "http://127.0.0.1:33364") {
			await route.continue();
			return;
		}
		unexpected.push(`${route.request().method()} ${url.href}`);
		await route.abort();
	});
	const ledger: Array<{ key: string; value: string; refused: boolean }> = [];
	writes.set(page, ledger);
	await page.exposeBinding(
		"__THEME_STORAGE_WRITE_LEDGER__",
		(_source, entry: { key: string; value: string; refused: boolean }) => {
			ledger.push(entry);
		}
	);
	const errors: string[] = [];
	browserErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page, request }, info) => {
	const storage = await page.evaluate(() => {
		const fault = (window as unknown as { __THEME_STORAGE_FAULT__?: Fault })
			.__THEME_STORAGE_FAULT__;
		return {
			fault: fault ?? null,
			registry: localStorage.getItem("ryu_custom_themes"),
			light: localStorage.getItem("ryu_light_preset"),
			dark: localStorage.getItem("ryu_dark_preset"),
		};
	});
	// Drain the real shipping best-effort publisher using an explicit fixture driver;
	// it does not mutate local storage or replace the tested consumer/store/hooks.
	const beforeDrain = await publisherControl(request);
	await page.evaluate(() =>
		(
			window as unknown as {
				__APPEARANCE_NATIVE_PUBLISHER__: { publish: () => void };
			}
		).__APPEARANCE_NATIVE_PUBLISHER__.publish()
	);
	await expect
		.poll(async () => {
			const receipt = await publisherControl(request);
			return (
				receipt.calls.length > beforeDrain.calls.length &&
				receipt.calls.every((call) => call.completed) &&
				receipt.preference !== null &&
				(storage.light === null ||
					receipt.preference.lightPreset === storage.light) &&
				(storage.dark === null ||
					receipt.preference.darkPreset === storage.dark) &&
				JSON.stringify(receipt.preference.customThemes) ===
					JSON.stringify(JSON.parse(storage.registry ?? "[]"))
			);
		})
		.toBe(true);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	await page.close();
	await expect
		.poll(async () =>
			(await publisherControl(request)).calls.every((call) => call.completed)
		)
		.toBe(true);
	const publisher = await publisherControl(request);
	if (storage.light !== null) {
		expect(publisher.preference?.lightPreset).toBe(storage.light);
	}
	if (storage.dark !== null) {
		expect(publisher.preference?.darkPreset).toBe(storage.dark);
	}
	expect(publisher.preference?.customThemes).toEqual(
		JSON.parse(storage.registry ?? "[]")
	);
	await info.attach("appearance-native-storage-ledger", {
		body: JSON.stringify({
			storage,
			publisher,
			unexpectedRequests: unexpectedRequests.get(page) ?? [],
			consoleErrors: consoleErrors.get(page) ?? [],
			writes: writes.get(page) ?? [],
			browserErrors: browserErrors.get(page) ?? [],
		}),
		contentType: "application/json",
	});
});

interface Fault {
	armed: boolean;
	attempts: Array<{ key: string; value: string; refused: boolean }>;
	blocked: boolean;
	target: string;
}
for (const mode of ["light", "dark"] as const) {
	for (const phase of ["registry", "active"] as const) {
		test(`${mode} custom preset ${phase} write refusal retains coherent selection/draft and retries one saved preset across reload`, async ({
			page,
		}) => {
			const selectedKey = `ryu_${mode}_preset`;
			const previousId = mode === "light" ? "ryu-light-mono" : "ryu-dark-mono";
			const previousLabel = mode === "light" ? "Ryu Light" : "Ryu Dark";
			const color = mode === "light" ? "#F4F4F5" : "#202124";
			const label = `Recovered ${mode} ${phase} theme`;
			await page.addInitScript(
				({ mode, selectedKey, previousId, phase }) => {
					if (!sessionStorage.getItem("appearance-quota-proof-seeded")) {
						localStorage.setItem("theme", mode);
						localStorage.setItem(selectedKey, previousId);
						localStorage.setItem("ryu_custom_themes", "[]");
						sessionStorage.setItem("appearance-quota-proof-seeded", "1");
					}
					const fault: Fault = {
						armed: false,
						blocked: true,
						target: phase === "registry" ? "ryu_custom_themes" : selectedKey,
						attempts: [],
					};
					Object.assign(window, { __THEME_STORAGE_FAULT__: fault });
					const original = Storage.prototype.setItem;
					Storage.prototype.setItem = function (key, value) {
						if (
							this === localStorage &&
							fault.armed &&
							["ryu_custom_themes", selectedKey].includes(key)
						) {
							const refused = fault.blocked && key === fault.target;
							fault.attempts.push({ key, value, refused });
							void (
								window as unknown as {
									__THEME_STORAGE_WRITE_LEDGER__: (entry: {
										key: string;
										value: string;
										refused: boolean;
									}) => Promise<void>;
								}
							).__THEME_STORAGE_WRITE_LEDGER__({ key, value, refused });
							if (refused) {
								throw new DOMException(
									"Owned theme storage is full",
									"QuotaExceededError"
								);
							}
						}
						return original.call(this, key, value);
					};
				},
				{ mode, selectedKey, previousId, phase }
			);
			await page.goto("/appearance-preset-persistence-proof.html");
			await expect(page.getByTestId("appearance-settings-proof")).toBeVisible();
			const current = page.getByRole("combobox").nth(mode === "light" ? 0 : 1);
			await expect(current).toContainText(previousLabel);
			await page.locator(`#${mode}-background`).click();
			await page.getByRole("textbox", { name: "Hex color value" }).fill(color);
			await page.keyboard.press("Escape");
			await expect(current).toContainText("Unsaved theme");
			const draftLabel = await current.innerText();
			await page
				.getByRole("button", { name: "Save as preset", exact: true })
				.click();
			const name = page.getByPlaceholder("Preset name…");
			await name.fill(label);
			await page.evaluate(() => {
				(
					window as unknown as { __THEME_STORAGE_FAULT__: Fault }
				).__THEME_STORAGE_FAULT__.armed = true;
			});
			await page.getByRole("button", { name: "Save", exact: true }).click();
			const state = () =>
				page.evaluate(
					({ selectedKey }) => {
						const fault = (
							window as unknown as { __THEME_STORAGE_FAULT__: Fault }
						).__THEME_STORAGE_FAULT__;
						return {
							attempts: fault.attempts,
							registry: localStorage.getItem("ryu_custom_themes"),
							selected: localStorage.getItem(selectedKey),
						};
					},
					{ selectedKey }
				);
			await expect
				.poll(
					async () =>
						(await state()).attempts.filter((attempt) => attempt.refused).length
				)
				.toBe(1);
			const refused = await state();
			expect(refused.selected).toBe(previousId);
			expect(refused.attempts.find((attempt) => attempt.refused)?.key).toBe(
				phase === "registry" ? "ryu_custom_themes" : selectedKey
			);
			if (phase === "registry") {
				expect(refused.registry).toBe("[]");
			}
			await expect(name).toHaveValue(label);
			await expect(current).toContainText(draftLabel);
			await expect(
				page.getByText(
					/(?:couldn.t|failed|unable).*(?:save|preset|theme)|storage.*full|quota.*exceeded/i
				)
			).toBeVisible();
			await page.evaluate(() => {
				(
					window as unknown as { __THEME_STORAGE_FAULT__: Fault }
				).__THEME_STORAGE_FAULT__.blocked = false;
			});
			await page.getByRole("button", { name: "Save", exact: true }).click();
			await expect(name).toBeHidden();
			await expect(current).toContainText(label);
			const final = await state();
			const themes = JSON.parse(final.registry!);
			expect(themes).toHaveLength(1); // Retry must not leave duplicate partial-save intents.
			expect(themes[0]).toMatchObject({
				label,
				tokens: { "--background": color },
			});
			expect(final.selected).toBe(themes[0].id);
			expect(final.attempts.filter((attempt) => attempt.refused)).toHaveLength(
				1
			);
			expect(
				final.attempts.some(
					(attempt) =>
						attempt.key === selectedKey &&
						!attempt.refused &&
						attempt.value === themes[0].id
				)
			).toBe(true);
			await page.reload();
			await expect(page.getByTestId("appearance-settings-proof")).toBeVisible();
			await expect(
				page.getByRole("combobox").nth(mode === "light" ? 0 : 1)
			).toContainText(label);
			expect(
				await page.evaluate(
					(selectedKey) => localStorage.getItem(selectedKey),
					selectedKey
				)
			).toBe(themes[0].id);
			expect(
				await page.evaluate(() =>
					getComputedStyle(document.documentElement)
						.getPropertyValue("--background")
						.trim()
				)
			).toBe(color);
		});
	}
}

test("canceling a refused light active-key save starts a new intent without replacing its already persisted provisional theme", async ({
	page,
}) => {
	await page.addInitScript(() => {
		if (!sessionStorage.getItem("appearance-new-intent-seeded")) {
			localStorage.setItem("theme", "light");
			localStorage.setItem("ryu_light_preset", "ryu-light-mono");
			localStorage.setItem("ryu_custom_themes", "[]");
			sessionStorage.setItem("appearance-new-intent-seeded", "1");
		}
		const fault: Fault = {
			armed: false,
			blocked: true,
			target: "ryu_light_preset",
			attempts: [],
		};
		Object.assign(window, { __THEME_STORAGE_FAULT__: fault });
		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (
				this === localStorage &&
				fault.armed &&
				["ryu_custom_themes", "ryu_light_preset"].includes(key)
			) {
				const refused = fault.blocked && key === fault.target;
				fault.attempts.push({ key, value, refused });
				void (
					window as unknown as {
						__THEME_STORAGE_WRITE_LEDGER__: (entry: {
							key: string;
							value: string;
							refused: boolean;
						}) => Promise<void>;
					}
				).__THEME_STORAGE_WRITE_LEDGER__({ key, value, refused });
				if (refused) {
					throw new DOMException(
						"Owned theme storage is full",
						"QuotaExceededError"
					);
				}
			}
			return original.call(this, key, value);
		};
	});
	await page.goto("/appearance-preset-persistence-proof.html");
	await expect(page.getByTestId("appearance-settings-proof")).toBeVisible();
	const current = page.getByRole("combobox").nth(0);
	await expect(current).toContainText("Ryu Light");
	await page.locator("#light-background").click();
	await page.getByRole("textbox", { name: "Hex color value" }).fill("#F4F4F5");
	await page.keyboard.press("Escape");
	await expect(current).toContainText("Unsaved theme");
	const draftLabel = await current.innerText();
	await page
		.getByRole("button", { name: "Save as preset", exact: true })
		.click();
	const name = page.getByPlaceholder("Preset name…");
	await name.fill("First provisional theme");
	await page.evaluate(() => {
		(
			window as unknown as { __THEME_STORAGE_FAULT__: Fault }
		).__THEME_STORAGE_FAULT__.armed = true;
	});
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(
						window as unknown as { __THEME_STORAGE_FAULT__: Fault }
					).__THEME_STORAGE_FAULT__.attempts.filter((entry) => entry.refused)
						.length
			)
		)
		.toBe(1);
	const first = await page.evaluate(() =>
		JSON.parse(localStorage.getItem("ryu_custom_themes")!)
	);
	expect(first).toHaveLength(1);
	expect(first[0]).toMatchObject({
		label: "First provisional theme",
		tokens: { "--background": "#F4F4F5" },
	});
	expect(
		await page.evaluate(() => localStorage.getItem("ryu_light_preset"))
	).toBe("ryu-light-mono");
	await expect(name).toHaveValue("First provisional theme");
	await expect(current).toContainText(draftLabel);
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(name).toBeHidden();
	await page.locator("#light-background").click();
	await page.getByRole("textbox", { name: "Hex color value" }).fill("#FDF0D0");
	await page.keyboard.press("Escape");
	await page
		.getByRole("button", { name: "Save as preset", exact: true })
		.click();
	await name.fill("Second independent theme");
	expect(
		await page.evaluate(() => localStorage.getItem("ryu_light_preset"))
	).toBe("ryu-light-mono");
	await page.evaluate(() => {
		(
			window as unknown as { __THEME_STORAGE_FAULT__: Fault }
		).__THEME_STORAGE_FAULT__.blocked = false;
	});
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(name).toBeHidden();
	await expect(current).toContainText("Second independent theme");
	const after = await page.evaluate(() => ({
		themes: JSON.parse(localStorage.getItem("ryu_custom_themes")!),
		selected: localStorage.getItem("ryu_light_preset"),
	}));
	expect(after.themes).toHaveLength(2);
	expect(
		after.themes.find((theme: { id: string }) => theme.id === first[0].id)
	).toEqual(first[0]);
	const second = after.themes.find(
		(theme: { label: string }) => theme.label === "Second independent theme"
	);
	expect(second.id).not.toBe(first[0].id);
	expect(second.tokens["--background"]).toBe("#FDF0D0");
	expect(after.selected).toBe(second.id);
	await page.reload();
	await expect(page.getByRole("combobox").nth(0)).toContainText(
		"Second independent theme"
	);
	expect(
		await page.evaluate(() =>
			getComputedStyle(document.documentElement)
				.getPropertyValue("--background")
				.trim()
		)
	).toBe("#FDF0D0");
	expect(
		await page.evaluate(() =>
			JSON.parse(localStorage.getItem("ryu_custom_themes")!)
		)
	).toEqual(after.themes);
});
