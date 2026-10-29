// Real-browser spec for the timezone-picker story (`e2e/harness/
// timezone-picker-story.{html,tsx}`), which mounts the REAL Appearance
// "Date & time" row — the app's only `Combobox` consumer.
//
// The contract under test:
//   • the trigger shows the human LABEL ("(GMT+09:00) Asia/Tokyo"), never the
//     raw stored id — the failure mode when the item stringifier is missing;
//   • typing filters against that same label, so a city name finds its zone;
//   • picking a zone reaches the shared formatters, not just the trigger — the
//     sample stamp beside the row is formatted by `formatDateTime`;
//   • the choice survives a reload, because it is persisted.
//
// The popup's search input is mounted and unmounted with the popup, so every
// open waits for a FRESH input: typing into the one still on its way out is a
// race that silently filters the wrong list.

import { expect, type Page, test } from "@playwright/test";

// Cold Vite compiles the settings + combobox module graph on first navigation.
test.describe.configure({ timeout: 90_000 });

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page, context }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
	context.on("page", (opened) => {
		opened.on("pageerror", (error) => errors.push(error.message));
	});
});
test.afterEach(({ page }) => {
	expect(pageErrors.get(page)).toEqual([]);
});

const STORY_URL = "/timezone-picker-story.html";
const SEARCH_PLACEHOLDER = "Search a city or zone…";

const trigger = (page: Page) =>
	page.locator("[data-slot='combobox-trigger']").first();

async function load(page: Page) {
	await page.goto(STORY_URL);
	await expect(trigger(page)).toBeVisible();
}

/** Open the popup and type `query`, waiting out the previous popup first. */
async function search(page: Page, query: string) {
	const input = page.getByPlaceholder(SEARCH_PLACEHOLDER);
	await expect(input).toHaveCount(0);
	await trigger(page).click();
	await expect(input).toBeVisible();
	await input.fill(query);
}

test("defaults to System and shows a label, not a raw zone id", async ({
	page,
}) => {
	await load(page);
	await expect(trigger(page)).toContainText("System (");
	const systemStamp = await page.evaluate(() =>
		new Intl.DateTimeFormat(undefined, {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).format(new Date("2026-01-15T23:30:00.000Z"))
	);
	await expect(page.getByTestId("sample-stamp")).toHaveText(systemStamp);
});

test("filters by city name and commits the picked zone", async ({ page }) => {
	await load(page);
	await search(page, "tokyo");

	// Filtering runs against the offset-prefixed label, so a bare city name has
	// to match — this is the assertion a missing `itemToStringLabel` fails.
	const option = page.getByRole("option", { name: /Asia\/Tokyo/ });
	await expect(option).toHaveCount(1);
	await option.click();

	await expect(trigger(page)).toContainText("(GMT+09:00) Asia/Tokyo");
	expect(await page.evaluate(() => localStorage.getItem("ryu:timezone"))).toBe(
		"Asia/Tokyo"
	);
	await expect(page.getByTestId("sample-stamp")).toContainText("08:30");
});

test("the picked zone reaches the shared formatters", async ({ page }) => {
	await load(page);
	const stamp = page.getByTestId("sample-stamp");

	await search(page, "tokyo");
	await page.getByRole("option", { name: /Asia\/Tokyo/ }).click();

	// 2026-01-15T23:30Z is 2026-01-16 08:30 in Tokyo: both the clock AND the
	// calendar day move, which is what makes this more than a re-label.
	await expect(stamp).toContainText("08:30");
	await expect(stamp).toContainText(/\b16\b/);

	await search(page, "Los Angeles");
	await page.getByRole("option", { name: /America\/Los Angeles/ }).click();

	// Same instant, the previous calendar day, seven hours earlier than Tokyo's
	// clock minus the date rollover.
	await expect(stamp).toContainText("15:30");
	await expect(stamp).toContainText(/\b15\b/);
});

test("the choice survives a reload", async ({ page }) => {
	await load(page);
	await search(page, "tokyo");
	await page.getByRole("option", { name: /Asia\/Tokyo/ }).click();
	await expect(trigger(page)).toContainText("Asia/Tokyo");

	await page.reload();
	await expect(trigger(page)).toContainText("Asia/Tokyo");
});

test("native cross-window storage clear resets the displayed zone and live stamp", async ({
	page,
	context,
}) => {
	await load(page);
	await search(page, "tokyo");
	await page.getByRole("option", { name: /Asia\/Tokyo/ }).click();
	await expect(trigger(page)).toContainText("Asia/Tokyo");

	const other = await context.newPage();
	try {
		await load(other);
		await expect(trigger(other)).toContainText("Asia/Tokyo");
		await expect(other.getByTestId("sample-stamp")).toContainText("08:30");
		const systemStamp = await other.evaluate(() =>
			new Intl.DateTimeFormat(undefined, {
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hourCycle: "h23",
			}).format(new Date("2026-01-15T23:30:00.000Z"))
		);

		// Native clear emits key=null only to OTHER same-origin documents.
		// The writer receives no storage event, so no local notification is invented.
		await page.evaluate(() => localStorage.clear());
		await expect
			.poll(() => other.evaluate(() => localStorage.getItem("ryu:timezone")))
			.toBeNull();
		await expect(trigger(other)).toContainText("System (");
		await expect(other.getByTestId("sample-stamp")).toHaveText(systemStamp);

		// A later timezone write must conserve unrelated data in the shared store.
		await other.evaluate(() =>
			localStorage.setItem("coverage:unrelated", "retained")
		);
		// The same subscription must still handle the next acknowledged real write.
		await search(page, "Los Angeles");
		await page.getByRole("option", { name: /America\/Los Angeles/ }).click();
		await expect(trigger(other)).toContainText("America/Los Angeles");
		expect(
			await other.evaluate(() => localStorage.getItem("coverage:unrelated"))
		).toBe("retained");
		await expect(other.getByTestId("sample-stamp")).toContainText("15:30");
		await other.reload();
		await expect(trigger(other)).toContainText("America/Los Angeles");
	} finally {
		await other.close();
	}
});

test("a top-level document without a saved zone follows external host projection", async ({
	page,
}) => {
	await load(page);
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:timezone")))
		.toBeNull();
	// Model the host's actual CSS projection, without replacing store/Intl/modules.
	await page.evaluate(() =>
		document.documentElement.style.setProperty("--ryu-timezone", "Asia/Tokyo")
	);
	await expect(trigger(page)).toContainText("Asia/Tokyo");
	await expect(page.getByTestId("sample-stamp")).toContainText("08:30");
	await page.evaluate(() =>
		document.documentElement.style.setProperty(
			"--ryu-timezone",
			"America/Los_Angeles"
		)
	);
	await expect(trigger(page)).toContainText("America/Los Angeles");
	await expect(page.getByTestId("sample-stamp")).toContainText("15:30");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:timezone")))
		.toBeNull();
});

test("denied picker writes stay session-only until a real selection retry becomes durable", async ({
	page,
	context,
}) => {
	await page.addInitScript(() => {
		if (localStorage.getItem("ryu:timezone") === null) {
			localStorage.setItem("ryu:timezone", "Europe/London");
			localStorage.setItem("coverage:unrelated", '{"retained":[1,2,3]}');
		}
	});
	await load(page);
	await expect(trigger(page)).toContainText("Europe/London");
	await expect(page.getByTestId("sample-stamp")).toContainText("23:30");
	const other = await context.newPage();
	try {
		await load(other);
		await expect(trigger(other)).toContainText("Europe/London");
		const originalStamp = await other.getByTestId("sample-stamp").textContent();
		expect(originalStamp).not.toBeNull();
		// Inject only a genuine platform-method refusal. The shipping picker,
		// store, native Intl, storage objects and events remain unchanged.
		await page.evaluate(() => {
			const nativeWrite = Storage.prototype.setItem;
			let refused = 0;
			Storage.prototype.setItem = function (
				this: Storage,
				key: string,
				value: string
			) {
				if (this === localStorage && key === "ryu:timezone") {
					refused += 1;
					throw new DOMException(
						"Timezone storage denied",
						"QuotaExceededError"
					);
				}
				return nativeWrite.call(this, key, value);
			};
			Reflect.set(window, "__timezoneWriteFault", {
				count: () => refused,
				restore: () => {
					Storage.prototype.setItem = nativeWrite;
				},
			});
		});
		await search(page, "tokyo");
		await page.getByRole("option", { name: /Asia\/Tokyo/ }).click();
		await expect(trigger(page)).toContainText("Asia/Tokyo");
		await expect(page.getByTestId("sample-stamp")).toContainText("08:30");
		await expect(page.getByTestId("sample-stamp")).toContainText(/\b16\b/);
		expect(
			await page.evaluate(() => {
				const fault = Reflect.get(window, "__timezoneWriteFault") as {
					count: () => number;
				};
				return fault.count();
			})
		).toBe(1);
		expect(
			await page.evaluate(() => localStorage.getItem("ryu:timezone"))
		).toBe("Europe/London");
		await expect(trigger(other)).toContainText("Europe/London");
		await expect(other.getByTestId("sample-stamp")).toHaveText(
			originalStamp as string
		);
		await other.reload();
		await expect(trigger(other)).toContainText("Europe/London");
		await expect(other.getByTestId("sample-stamp")).toHaveText(
			originalStamp as string
		);
		await page.evaluate(() => {
			const fault = Reflect.get(window, "__timezoneWriteFault") as {
				restore: () => void;
			};
			fault.restore();
		});
		// A genuine writer reload must also lose the session-only selection.
		await page.reload();
		await expect(trigger(page)).toContainText("Europe/London");
		await expect(page.getByTestId("sample-stamp")).toHaveText(
			originalStamp as string
		);
		// Retry the same denied user choice through the real picker. Native
		// cross-window delivery must acknowledge the newly durable clock/day.
		await search(page, "tokyo");
		await page.getByRole("option", { name: /Asia\/Tokyo/ }).click();
		await expect(trigger(page)).toContainText("Asia/Tokyo");
		await expect(trigger(other)).toContainText("Asia/Tokyo");
		for (const consumer of [page, other]) {
			await expect(consumer.getByTestId("sample-stamp")).toContainText("08:30");
			await expect(consumer.getByTestId("sample-stamp")).toContainText(
				/\b16\b/
			);
			expect(
				await consumer.evaluate(() => localStorage.getItem("ryu:timezone"))
			).toBe("Asia/Tokyo");
			expect(
				await consumer.evaluate(() =>
					localStorage.getItem("coverage:unrelated")
				)
			).toBe('{"retained":[1,2,3]}');
			await consumer.reload();
			await expect(trigger(consumer)).toContainText("Asia/Tokyo");
			await expect(consumer.getByTestId("sample-stamp")).toContainText("08:30");
			await expect(consumer.getByTestId("sample-stamp")).toContainText(
				/\b16\b/
			);
			expect(
				await consumer.evaluate(() =>
					localStorage.getItem("coverage:unrelated")
				)
			).toBe('{"retained":[1,2,3]}');
		}
	} finally {
		await page.evaluate(() => {
			const fault = Reflect.get(window, "__timezoneWriteFault") as
				| {
						restore: () => void;
				  }
				| undefined;
			fault?.restore();
		});
		await other.close();
	}
});

test("same-origin sessionStorage events cannot discard a session-only zone or the live localStorage subscription", async ({
	page,
	context,
}) => {
	await page.addInitScript(() => {
		if (localStorage.getItem("ryu:timezone") === null) {
			localStorage.setItem("ryu:timezone", "Europe/London");
			localStorage.setItem("coverage:unrelated", '{"retained":[1,2,3]}');
		}
	});
	await load(page);
	await expect(trigger(page)).toContainText("Europe/London");
	// Genuine platform-method refusal for this page's durable timezone write only.
	await page.evaluate(() => {
		const nativeWrite = Storage.prototype.setItem;
		Storage.prototype.setItem = function (
			this: Storage,
			key: string,
			value: string
		) {
			if (this === localStorage && key === "ryu:timezone") {
				throw new DOMException("Timezone storage denied", "QuotaExceededError");
			}
			return nativeWrite.call(this, key, value);
		};
		Reflect.set(window, "__timezoneWriteRestore", () => {
			Storage.prototype.setItem = nativeWrite;
		});
	});
	const other = await context.newPage();
	try {
		await search(page, "tokyo");
		await page.getByRole("option", { name: /Asia\/Tokyo/ }).click();
		await expect(trigger(page)).toContainText("Asia/Tokyo");
		await expect(page.getByTestId("sample-stamp")).toContainText("08:30");
		expect(
			await page.evaluate(() => localStorage.getItem("ryu:timezone"))
		).toBe("Europe/London");
		// A same-origin child document shares this tab's sessionStorage area, so
		// the native engine delivers its writes to this window as storage events.
		await page.evaluate(() => {
			const received: Array<string | null> = [];
			Reflect.set(window, "__sessionStorageEvents", received);
			window.addEventListener("storage", (event) => {
				if (event.storageArea === sessionStorage) {
					received.push(event.key);
				}
			});
			const writer = document.createElement("iframe");
			writer.title = "Same-origin session writer";
			writer.srcdoc =
				"<script>sessionStorage.setItem('ryu:timezone','America/Los_Angeles');sessionStorage.clear();</script>";
			document.body.append(writer);
		});
		await expect
			.poll(() =>
				page.evaluate(() => Reflect.get(window, "__sessionStorageEvents"))
			)
			.toEqual(["ryu:timezone", null]);
		// The projection token is written synchronously by an accepted storage
		// signal; it still carries the session-only choice after both events.
		expect(
			await page.evaluate(() =>
				document.documentElement.style.getPropertyValue("--ryu-timezone")
			)
		).toBe("Asia/Tokyo");
		await page.evaluate(
			() =>
				new Promise((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(resolve))
				)
		);
		await expect(trigger(page)).toContainText("Asia/Tokyo");
		await expect(page.getByTestId("sample-stamp")).toContainText("08:30");
		expect(
			await page.evaluate(() => ({
				session: sessionStorage.length,
				timezone: localStorage.getItem("ryu:timezone"),
				unrelated: localStorage.getItem("coverage:unrelated"),
			}))
		).toEqual({
			session: 0,
			timezone: "Europe/London",
			unrelated: '{"retained":[1,2,3]}',
		});
		// A genuine localStorage-area write from another window is still accepted.
		await load(other);
		await expect(trigger(other)).toContainText("Europe/London");
		await search(other, "Los Angeles");
		await other.getByRole("option", { name: /America\/Los Angeles/ }).click();
		await expect(trigger(page)).toContainText("America/Los Angeles");
		await expect(page.getByTestId("sample-stamp")).toContainText("15:30");
		expect(
			await page.evaluate(() => localStorage.getItem("coverage:unrelated"))
		).toBe('{"retained":[1,2,3]}');
	} finally {
		await page.evaluate(() => {
			const restore = Reflect.get(window, "__timezoneWriteRestore");
			if (typeof restore === "function") {
				restore();
			}
		});
		await other.close();
	}
});
