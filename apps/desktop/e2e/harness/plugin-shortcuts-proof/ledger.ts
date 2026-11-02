// Shared fixture control, ledger hooks and row helpers for
// plugin-shortcuts-proof.spec.ts (split out of the spec to keep it under the
// file-size limit; the behaviour is unchanged).
import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";

export const HOST = "http://127.0.0.1:33367";
export type Document = Record<string, string | null>;
export interface Call {
	admitted: boolean;
	authority: string;
	authorization: string | null;
	buyerToken: string | null;
	completed: boolean;
	contentType: string | null;
	delegation: string | null;
	document?: Document;
	endpoint: string;
	/** The `POST /api/keybindings/entry` edit, once the body was admitted. */
	entry?: { entry: string; remove?: true; value?: string | null };
	id: number;
	method: string;
	preferenceValue?: string | null;
	query: string;
	rawBody: string;
	status: number;
}
export interface Receipt {
	calls: Call[];
	disk: { a: Document; b: Document };
	held: Array<{ id: number }>;
	rawDisk: {
		a: { bytes: string; sha256: string };
		b: { bytes: string; sha256: string };
	};
	unexpectedNative: string[];
}
export const errors = new WeakMap<Page, string[]>();
const consoles = new WeakMap<Page, string[]>();
export const unexpected = new WeakMap<Page, string[]>();
export async function control(
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
export async function settled(request: APIRequestContext) {
	await expect
		.poll(async () => {
			const state = await control(request);
			return (
				state.held.length === 0 && state.calls.every((call) => call.completed)
			);
		})
		.toBe(true);
}
export const pluginRow = (page: Page, label: string) =>
	page
		.locator('[data-slot="item"]')
		.filter({ has: page.getByText(label, { exact: true }) });
export async function record(page: Page, label: string, chord: string) {
	const row = pluginRow(page, label);
	await expect(row).toHaveCount(1);
	const recorder = row.locator("button").filter({ has: page.locator("kbd") });
	await expect(recorder).toHaveCount(1);
	await recorder.click();
	await expect(row.getByText("Press keys…", { exact: true })).toBeVisible();
	await page.keyboard.press(chord);
}
/** Every plugin shortcut write: Core's per-entry `POST /api/keybindings/entry`. */
export const entryWrites = (receipt: Receipt) =>
	receipt.calls.filter(
		(call) =>
			call.method === "POST" && call.endpoint === "/api/keybindings/entry"
	);
export async function twoFrames(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
}
export async function selectAuthority(page: Page, keys: Array<"a" | "b">) {
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

/** Fixture reset, origin guard and the native authority ledger checks for every test. */
export function registerNativeLedgerHooks() {
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
				["http://127.0.0.1:33367", "http://127.0.0.1:33368"].includes(
					url.origin
				)
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
}
