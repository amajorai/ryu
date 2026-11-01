// Shared fixture for the agent posture native-HTTP proof: the owned Core
// host's state/control endpoints and the editor navigation helpers.
import { expect, type Page } from "@playwright/test";

export const CORE = "http://127.0.0.1:5731";
export const PATH = "/api/agents/version-proof";
export interface Call {
	authorization: string | null;
	body: unknown;
	id: number;
	jwt: string | null;
	method: string;
	path: string;
	scope: "a" | "b" | null;
	status: number | null;
}
export interface Agent {
	lifecycle_status: string;
	name: string;
	safety_profile: string;
	skills: string[];
	system_prompt: string;
	tools: string[];
}
export interface State {
	calls: Call[];
	held: number[];
	records: { a: Agent; b: Agent };
	unexpected: Call[];
}
export async function state(page: Page): Promise<State> {
	const response = await page.request.get(`${CORE}/__state`);
	expect(response.status()).toBe(200);
	return response.json();
}
export async function control(page: Page, body: unknown) {
	const response = await page.request.post(`${CORE}/__control`, {
		headers: { "x-proof-control": "owned-posture-proof" },
		data: body,
	});
	expect(response.status()).toBe(200);
}
export const writes = (snapshot: State) =>
	snapshot.calls.filter((call) => call.path === PATH && call.method === "PUT");
export async function boot(page: Page) {
	await page.goto("/agent-posture-native-http.html");
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		"Current agent"
	);
	await page
		.getByRole("tab", { name: "Tools & knowledge", exact: true })
		.click();
	await expect(page.getByLabel("Agent lifecycle")).toHaveValue("active");
}
export async function switchTo(page: Page, scope: "a" | "b") {
	await page
		.getByRole("button", {
			name: `Use scope ${scope.toUpperCase()}`,
			exact: true,
		})
		.click();
	await page.getByRole("tab", { name: "Behavior", exact: true }).click();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		scope === "a" ? "Current agent" : "Scope B agent"
	);
	const tab = page.getByRole("tab", { name: "Tools & knowledge", exact: true });
	if (!(await page.getByLabel("Agent lifecycle").isVisible())) {
		await tab.click();
	}
	await expect(page.getByLabel("Agent lifecycle")).toHaveValue(
		scope === "a" ? "active" : "trial"
	);
}
export async function independentRead(
	page: Page,
	scope: "a" | "b"
): Promise<Agent> {
	const response = await page.request.get(`${CORE}/scope-${scope}${PATH}`, {
		headers: {
			authorization: `Bearer version-bearer-${scope}`,
			"x-ryu-user-jwt": `version-user-${scope}`,
		},
	});
	expect(response.status()).toBe(200);
	return (await response.json()).agent;
}
export async function consumedResponse(
	page: Page,
	response: Promise<import("@playwright/test").Response>
) {
	await (await response).finished();
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
}
/** Saving a name/tone (prompt-layer) change on a saved bot asks before it
 * resets each thread's prompt cache (promptEditCacheWarning in
 * AgentEditPage-save.ts, pre-#914); apply it so the full save is sent. */
export async function applyPromptCacheReset(page: Page): Promise<void> {
	const confirm = page.getByRole("alertdialog", {
		name: "Apply now? This resets the prompt cache",
	});
	await expect(confirm).toBeVisible();
	await confirm.getByRole("button", { name: "Apply now" }).click();
	await expect(confirm).toHaveCount(0);
}
