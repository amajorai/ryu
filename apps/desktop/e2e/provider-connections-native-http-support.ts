// Shared fake-Core helpers and per-test hooks for the provider connections
// native-HTTP proof specs (split from provider-connections-native-http.spec.ts
// to stay under the file size limit).
import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import type { ProviderCall } from "./provider-connections-native-http-state.ts";

export const core = "http://127.0.0.1:5691";
export interface Snapshot {
	calls: ProviderCall[];
	catalog: {
		providers: Array<{
			id: string;
			routing: string;
			configured: boolean;
			modelOverrides?: Record<string, boolean>;
			accounts?: Array<{
				accountId: string;
				label: string;
				active: boolean;
				gatewayActive?: boolean;
			}>;
		}>;
	};
	config: {
		provider: string;
		model: string | null;
		thinkingLevel: string | null;
	};
	heldRequestKeys: string[];
	policy: unknown;
	secrets: Record<string, string>;
	unexpected: string[];
}
export const state = async (request: APIRequestContext): Promise<Snapshot> => {
	const response = await request.get(`${core}/__provider-state`);
	expect(response.ok()).toBe(true);
	return response.json();
};
export async function control(
	request: APIRequestContext,
	action: string,
	method?: string,
	path?: string,
	status?: number,
	model?: string
) {
	const response = await request.post(`${core}/__provider-control`, {
		headers: { "x-proof-control": "owned-fixture" },
		data: { action, method, path, status, model },
	});
	expect(response.ok()).toBe(true);
}
export function cardButton(page: Page, label: string) {
	return page
		.getByRole("button")
		.filter({ has: page.getByText(label, { exact: true }) });
}
export async function open(page: Page, label: string) {
	await cardButton(page, label).click();
}
export const writes = (snapshot: Snapshot, path: string) =>
	snapshot.calls.filter((c) => c.path === path && c.method !== "GET");
const errors = new WeakMap<Page, string[]>();

/** Registers the reset and no-unexpected-request checks around every test. */
export function registerProviderProofHooks(): void {
	test.beforeEach(async ({ page, request }) => {
		const list: string[] = [];
		errors.set(page, list);
		page.on("pageerror", (error) => list.push(error.message));
		await control(request, "reset");
	});
	test.afterEach(async ({ page, request }) => {
		for (const key of (await state(request)).heldRequestKeys) {
			const split = key.indexOf(" ");
			await control(
				request,
				"release",
				key.slice(0, split),
				key.slice(split + 1)
			);
		}
		await expect
			.poll(async () =>
				(await state(request)).calls.every((call) => call.status !== 0)
			)
			.toBe(true);
		const snapshot = await state(request);
		expect(snapshot.unexpected).toEqual([]);
		expect(
			(await (await request.get(`${core}/__state`)).json()).unexpected
		).toEqual([]);
		expect(
			await page.evaluate(() =>
				Reflect.get(window, "__providerProofNativeUnexpected")
			)
		).toEqual([]);
		expect(errors.get(page)).toEqual([]);
	});
}
