import { expect, test } from "@playwright/test";
import { DESKTOP_HOTKEYS } from "../src/lib/hotkeys/actions.ts";
import type { ShortcutProofState } from "./harness/keyboard-shortcuts-proof.types.ts";

const STORY_URL = "/keyboard-shortcuts-proof.html";

type DictationPrefs = ShortcutProofState["__shortcutDictationPrefs"];
interface DictationWire {
	baseline: DictationPrefs | null;
	holdNext: boolean;
	inFlight: Set<Promise<void>>;
	origin: string | null;
	release: ((accept: boolean) => void) | null;
	routeErrors: string[];
	saved: DictationPrefs | null;
	unexpected: string[];
	writes: Array<{ value: string }>;
}
const wires = new WeakMap<import("@playwright/test").Page, DictationWire>();
/**
 * Each recorded PUT decoded to its complete preference. The route already
 * enforces one canonical JSON `value` per write; JSON object key order carries
 * no meaning, so the serializer's field order is not part of the contract.
 */
function decodedWrites(wire: DictationWire): { value: DictationPrefs }[] {
	return wire.writes.map(({ value }) => ({ value: JSON.parse(value) }));
}
async function clickVisibleControlWithMouse(
	page: import("@playwright/test").Page,
	control: import("@playwright/test").Locator
) {
	await expect(control).toBeVisible();
	await control.scrollIntoViewIfNeeded();
	const box = await control.boundingBox();
	if (!box || box.width <= 0 || box.height <= 0) {
		throw new Error(
			"Expected visible control with nonempty mouse target bounds"
		);
	}
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function settleInputFrames(page: import("@playwright/test").Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			})
	);
}

test.beforeEach(async ({ page }) => {
	const wire: DictationWire = {
		origin: null,
		inFlight: new Set(),
		routeErrors: [],
		baseline: null,
		saved: null,
		writes: [],
		unexpected: [],
		holdNext: false,
		release: null,
	};
	wires.set(page, wire);
	await page.exposeBinding(
		"__registerShortcutTransport",
		(_, input: { origin: string; prefs: DictationPrefs }) => {
			const origin = new URL(input.origin).origin;
			if (wire.origin && wire.origin !== origin) {
				throw new Error("Shortcut fixture authority changed across reload");
			}
			wire.origin = origin;
			if (!wire.baseline) {
				wire.baseline = structuredClone(input.prefs);
				wire.saved = structuredClone(input.prefs);
			}
		}
	);
	const handleRequest = async (route: import("@playwright/test").Route) => {
		const request = route.request();
		const headers = {
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "GET, PUT, OPTIONS",
			"access-control-allow-headers":
				"authorization, content-type, x-ryu-surface",
		};
		const origin = wire.origin;
		if (!origin) {
			throw new Error(
				"Actual shortcut transport was not registered before its first request"
			);
		}
		if (
			new URL(request.url()).origin !== origin ||
			!["GET", "PUT", "OPTIONS"].includes(request.method())
		) {
			wire.unexpected.push(`${request.method()} ${request.url()}`);
			await route.fulfill({
				headers,
				status: 503,
				json: { error: "Unexpected dictation authority or verb" },
			});
			return;
		}
		if (request.method() === "OPTIONS") {
			await route.fulfill({ status: 204, headers });
			return;
		}

		if (request.method() === "PUT") {
			const body = request.postDataJSON();
			expect(Object.keys(body)).toEqual(["value"]);
			expect(body.value).toEqual(JSON.stringify(JSON.parse(body.value)));
			expect(request.headers()["content-type"]).toContain("application/json");
			wire.writes.push(structuredClone(body));
			if (wire.holdNext) {
				wire.holdNext = false;
				const accept = await new Promise<boolean>((resolve) => {
					wire.release = resolve;
				});
				wire.release = null;
				if (!accept) {
					await route.fulfill({
						headers,
						status: 503,
						json: { error: "Dictation shortcut save refused" },
					});
					return;
				}
			}
			wire.saved = JSON.parse(body.value);
		}
		await route.fulfill({
			headers,
			json: { key: "dictation", value: JSON.stringify(wire.saved) },
		});
	};
	await page.route("**/api/preferences/dictation", (route) => {
		const task = handleRequest(route);
		wire.inFlight.add(task);
		void task.then(
			() => wire.inFlight.delete(task),
			(error: Error) => {
				wire.routeErrors.push(error.message);
				wire.inFlight.delete(task);
			}
		);
		return task;
	});
});
test.afterEach(async ({ page }) => {
	const wire = wires.get(page);
	wire?.release?.(false);
	if (wire?.origin) {
		await page.evaluate(() => window.__shortcutUnmount());
	}
	await page.unrouteAll({ behavior: "wait" });
	if (wire) {
		await Promise.all([...wire.inFlight]);
	}
	expect(wire?.inFlight.size).toBe(0);
	expect(wire?.routeErrors).toEqual([]);
	expect(wire?.unexpected).toEqual([]);
});

async function chooseOption(
	page: import("@playwright/test").Page,
	trigger: import("@playwright/test").Locator,
	label: string
) {
	await trigger.click();
	const listboxId = await trigger.getAttribute("aria-controls");
	const listbox = listboxId
		? page.locator(`[id="${listboxId}"]`)
		: page.getByRole("listbox").last();
	await listbox.getByRole("option", { exact: true, name: label }).click();
}

test.describe.configure({ timeout: 90_000 });

test("records, clears, and resets every in-app shortcut action", async ({
	page,
}) => {
	page.setDefaultTimeout(5000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await expect(page.getByTestId("keyboard-shortcuts-proof")).toBeVisible();

	const actions = DESKTOP_HOTKEYS.filter((action) => !action.global);
	for (const action of actions) {
		const recorder = page.getByTestId(`shortcut-recorder-${action.id}`);
		const clear = page.getByTestId(`shortcut-clear-${action.id}`);
		const reset = page.getByTestId(`shortcut-reset-${action.id}`);
		await expect(recorder).toBeVisible();
		await recorder.click();
		await expect(recorder).toContainText("Press keys…");
		await page.keyboard.press("Escape");
		await expect(recorder).not.toContainText("Press keys…");

		if (action.defaultBinding === null) {
			await expect(recorder).toContainText("Unbound");
			await expect(clear).toBeDisabled();
			await expect(reset).toBeDisabled();
			continue;
		}

		await expect(clear).toBeEnabled();
		await clear.click();
		await expect(recorder).toContainText("Unbound");
		await expect(clear).toBeDisabled();
		await expect(reset).toBeEnabled();
		await reset.click();
		await expect(reset).toBeDisabled();
		await expect(recorder).not.toContainText("Unbound");
	}
	await expect
		.poll(() =>
			page.evaluate(() => Object.keys(window.__shortcutOverrides).length)
		)
		.toBe(0);

	const commandPalette = page.getByTestId(
		"shortcut-recorder-command-palette.toggle"
	);
	await commandPalette.click();
	await page.keyboard.press("F10");
	await expect(commandPalette).toContainText("F10");
	await page.getByTestId("keyboard-shortcuts-reset-all").click();
	const resetDialog = page.getByRole("alertdialog");
	await expect(resetDialog).toBeVisible();
	await resetDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(commandPalette).toContainText("F10");
	await page.getByTestId("keyboard-shortcuts-reset-all").click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Reset all to defaults" })
		.click();
	await expect(commandPalette).not.toContainText("F10");
	await expect
		.poll(() =>
			page.evaluate(() => Object.keys(window.__shortcutOverrides).length)
		)
		.toBe(0);

	const filter = page.getByRole("textbox", {
		name: "Filter keyboard shortcuts",
	});
	await filter.fill("New Tab");
	await expect(page.getByTestId("shortcut-recorder-tab.new")).toBeVisible();
	await expect(
		page.getByTestId("shortcut-recorder-tab.close")
	).not.toBeVisible();
	await filter.fill("no matching action");
	await expect(page.getByText(/No keyboard shortcuts match/)).toBeVisible();
	await filter.fill("");
});

test("saves chat modifiers and global dictation shortcuts", async ({
	page,
}) => {
	page.setDefaultTimeout(5000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);

	const quickReply = page.getByRole("combobox", {
		name: "Quick reply click modifier",
	});
	await chooseOption(page, quickReply, "Shift");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:quick-reply-modifier"))
	).resolves.toBe("shift");
	const quickPreview = page.getByRole("combobox", {
		name: "Quick preview click modifier",
	});
	await chooseOption(page, quickPreview, "Off");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:quick-preview-modifier"))
	).resolves.toBe("none");

	const filter = page.getByRole("textbox", {
		name: "Filter keyboard shortcuts",
	});
	await filter.fill("Global");
	const dictationRecorder = page.getByTestId(
		"global-shortcut-recorder-system-wide-dictation"
	);
	await expect(dictationRecorder).toBeVisible();
	await dictationRecorder.click();
	await page.keyboard.press("F8");
	await expect(dictationRecorder).toContainText("F8");
	await expect
		.poll(() => page.evaluate(() => window.__shortcutDictationPrefs.shortcut))
		.toBe("F8");
	await page.getByTestId("global-shortcut-reset-system-wide-dictation").click();
	await expect
		.poll(() => page.evaluate(() => window.__shortcutDictationPrefs.shortcut))
		.toBe("CommandOrControl+Shift+D");

	const agentAskRecorder = page.getByTestId(
		"global-shortcut-recorder-agent-ask"
	);
	await agentAskRecorder.click();
	await page.keyboard.press("F9");
	await expect(agentAskRecorder).toContainText("F9");
	await expect
		.poll(() =>
			page.evaluate(() => window.__shortcutDictationPrefs.ask.shortcut)
		)
		.toBe("F9");
	await page.getByTestId("global-shortcut-reset-agent-ask").click();
	await expect
		.poll(() =>
			page.evaluate(() => window.__shortcutDictationPrefs.ask.shortcut)
		)
		.toBe("CommandOrControl+Shift+A");
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("desktop-keyboard-shortcuts-proof.png"),
	});
});

for (const [label, key] of [
	["system-wide-dictation", "shortcut"],
	["agent-ask", "ask"],
] as const) {
	test(`${label} refused HTTP save preserves the saved shortcut, reports failure, then explicit retry and reload read back the exact complete preference`, async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await page
			.getByRole("textbox", { name: "Filter keyboard shortcuts" })
			.fill("Global");
		const recorder = page.getByTestId(`global-shortcut-recorder-${label}`);
		const wire = wires.get(page);
		if (!wire) {
			throw new Error("Missing installed dictation wire fixture");
		}
		await expect.poll(() => wire.baseline).not.toBeNull();
		if (!wire.baseline) {
			throw new Error("Dictation initial GET did not complete");
		}
		const before = structuredClone(wire.baseline);
		const next = structuredClone(before);
		if (key === "ask") {
			next.ask.shortcut = "F9";
		} else {
			next.shortcut = "F8";
		}
		const chord = key === "ask" ? "F9" : "F8";
		wire.holdNext = true;
		await recorder.click();
		await page.keyboard.press(chord);
		await expect.poll(() => wire.writes.length).toBe(1);
		expect(decodedWrites(wire)).toEqual([{ value: next }]);
		expect(wire.saved).toEqual(before);
		// A pending save must not create a second concurrent preference mutation.
		const pendingReset = page.getByTestId(`global-shortcut-reset-${label}`);
		await expect(pendingReset).toBeDisabled();
		await clickVisibleControlWithMouse(page, pendingReset);
		await settleInputFrames(page);
		await expect.poll(() => wire.inFlight.size).toBe(1);
		expect(wire.routeErrors).toEqual([]);
		expect(wire.writes).toHaveLength(1);
		if (!wire.release) {
			throw new Error("Expected a held HTTP PUT");
		}
		wire.release(false);
		await expect(
			page.getByText(
				`Couldn't update ${key === "ask" ? "Agent Ask" : "System-Wide Dictation"}`,
				{ exact: true }
			)
		).toBeVisible();
		await expect(recorder).not.toContainText(chord);
		expect(wire.saved).toEqual(before);
		await recorder.click();
		await page.keyboard.press(chord);
		await expect.poll(() => wire.writes.length).toBe(2);
		expect(decodedWrites(wire)[1]).toEqual({ value: next });
		await expect.poll(() => wire.saved).toEqual(next);
		await page.reload();
		await page
			.getByRole("textbox", { name: "Filter keyboard shortcuts" })
			.fill("Global");
		await expect(
			page.getByTestId(`global-shortcut-recorder-${label}`)
		).toContainText(chord);
		expect(wire.writes).toHaveLength(2);
	});
}

test("in-app refused HotkeyStorage save retains the session binding, leaves saved state unchanged and retries durably after reload", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	const recorder = page.getByTestId("shortcut-recorder-command-palette.toggle");
	await expect(recorder).not.toContainText("F10");
	await page.evaluate(() => {
		window.__shortcutStorage.refuseNext = true;
	});
	await recorder.click();
	await page.keyboard.press("F10");
	await expect(recorder).toContainText("F10");
	await expect
		.poll(() => page.evaluate(() => window.__shortcutStorage.calls))
		.toEqual([{ "command-palette.toggle": "F10" }]);
	expect(
		await page.evaluate(() =>
			localStorage.getItem("shortcut-proof-saved-overrides")
		)
	).toBeNull();
	expect(await page.evaluate(() => window.__shortcutOverrides)).toEqual({});
	await page.reload();
	await expect(
		page.getByTestId("shortcut-recorder-command-palette.toggle")
	).not.toContainText("F10");
	await page.getByTestId("shortcut-recorder-command-palette.toggle").click();
	await page.keyboard.press("F10");
	await expect
		.poll(() =>
			page.evaluate(() =>
				localStorage.getItem("shortcut-proof-saved-overrides")
			)
		)
		.toBe(JSON.stringify({ "command-palette.toggle": "F10" }));
	await page.reload();
	await expect(
		page.getByTestId("shortcut-recorder-command-palette.toggle")
	).toContainText("F10");
});

test("shared dictation preference serializes different global rows and preserves both saved shortcuts after reload", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await page
		.getByRole("textbox", { name: "Filter keyboard shortcuts" })
		.fill("Global");
	const wire = wires.get(page);
	if (!wire) {
		throw new Error("Missing installed dictation wire fixture");
	}
	await expect.poll(() => wire.baseline).not.toBeNull();
	if (!wire.baseline) {
		throw new Error("Dictation initial GET did not complete");
	}
	const dictation = page.getByTestId(
		"global-shortcut-recorder-system-wide-dictation"
	);
	const ask = page.getByTestId("global-shortcut-recorder-agent-ask");
	wire.holdNext = true;
	await dictation.click();
	await page.keyboard.press("F8");
	await expect.poll(() => wire.writes.length).toBe(1);
	const savedDictation = { ...wire.baseline, shortcut: "F8" };
	expect(decodedWrites(wire)[0]).toEqual({ value: savedDictation });
	// Physical input into the other row while the real first HTTP write is held
	// must not start a second complete-object write from the stale saved prefs.
	await expect(ask).toBeDisabled();
	await expect(dictation).toBeDisabled();
	await clickVisibleControlWithMouse(page, ask);
	await page.keyboard.press("F9");
	await settleInputFrames(page);
	await expect.poll(() => wire.inFlight.size).toBe(1);
	expect(wire.routeErrors).toEqual([]);
	expect(wire.writes).toHaveLength(1);
	if (!wire.release) {
		throw new Error("Expected held dictation write");
	}
	wire.release(true);
	await expect.poll(() => wire.saved).toEqual(savedDictation);
	await expect(ask).toBeEnabled();
	await ask.click();
	await page.keyboard.press("F9");
	const savedBoth = {
		...savedDictation,
		ask: { ...savedDictation.ask, shortcut: "F9" },
	};
	await expect.poll(() => wire.writes.length).toBe(2);
	expect(decodedWrites(wire)[1]).toEqual({ value: savedBoth });
	await expect.poll(() => wire.saved).toEqual(savedBoth);
	await page.reload();
	await page
		.getByRole("textbox", { name: "Filter keyboard shortcuts" })
		.fill("Global");
	await expect(dictation).toContainText("F8");
	await expect(ask).toContainText("F9");
	expect(wire.writes).toHaveLength(2);
});
