import { writeFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const url = "/rules-agent-edit-panel-proof.html?profiles=true";
const key = "ryu:e2e:rules-agent-edit-panel";
const agentPath = "/api/agents/rules-panel-proof-agent";
interface Snapshot {
	outputStyleId?: string | null;
	requests: {
		method: string;
		path: string;
		status: number;
		body: { persona?: { output_style_id?: string | null } };
	}[];
}
async function snapshot(page: Page): Promise<Snapshot> {
	return page.evaluate(
		(storageKey) => JSON.parse(localStorage.getItem(storageKey) ?? "{}"),
		key
	);
}
async function pick(page: Page, name: string) {
	await page.locator("#agent-personality-profile").click();
	await page.getByRole("option", { name, exact: true }).click();
	await expect(page.locator("#agent-personality-profile")).toContainText(name);
}

test("production agent editor saves profile, retries refusal and reads persisted choice after reopening", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`${url}&reset=true`, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#agent-personality-profile")).toBeVisible();
	for (const profile of [
		"ELI5",
		"I have ADHD",
		"Concise",
		"Explanatory",
		"Learning",
		"Proactive",
		"Plain text",
		"Plain Technical",
		"No AI slop",
		"No Hype",
		"Bro",
		"Gen Z",
	]) {
		await pick(page, profile);
	}
	await pick(page, "Concise");
	await page.evaluate(() =>
		window.__outputStylesAgentProof?.failNextAgentWrite()
	);
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(
		page.getByText(`${agentPath} failed: 503`, { exact: true })
	).toBeVisible();
	let state = await snapshot(page);
	expect(state.outputStyleId ?? null).toBeNull();
	let writes = state.requests.filter(
		(request) => request.path === agentPath && request.method === "PUT"
	);
	expect(writes).toHaveLength(1);
	expect(writes[0]?.status).toBe(503);
	expect(writes[0]?.body.persona?.output_style_id).toBe("concise");
	await expect(page.locator("#agent-personality-profile")).toContainText(
		"Concise"
	);
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByTestId("agent-list-returned")).toBeVisible();
	state = await snapshot(page);
	writes = state.requests.filter(
		(request) => request.path === agentPath && request.method === "PUT"
	);
	expect(writes).toHaveLength(2);
	expect(writes[1]?.status).toBe(200);
	expect(writes[1]?.body.persona?.output_style_id).toBe("concise");
	expect(state.outputStyleId).toBe("concise");
	expect(
		state.requests.some(
			(request) =>
				request.path === "/api/output-styles" && request.method === "GET"
		)
	).toBe(true);
	await page.goto(url, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#agent-personality-profile")).toContainText(
		"Concise"
	);
	await pick(page, "ELI5");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(page.getByTestId("agent-list-returned")).toBeVisible();
	state = await snapshot(page);
	expect(state.outputStyleId).toBe("concise");
	expect(
		state.requests.filter(
			(request) => request.path === agentPath && request.method === "PUT"
		)
	).toHaveLength(2);
	await page.goto(url, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#agent-personality-profile")).toContainText(
		"Concise"
	);
	await page.screenshot({
		path: test.info().outputPath("agent-profile-saved-readback.png"),
		fullPage: true,
	});
	await pick(page, "Agent's own voice");
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByTestId("agent-list-returned")).toBeVisible();
	state = await snapshot(page);
	expect(state.outputStyleId).toBeNull();
	writes = state.requests.filter(
		(request) => request.path === agentPath && request.method === "PUT"
	);
	expect(writes).toHaveLength(3);
	expect(writes[2]?.body.persona?.output_style_id).toBeNull();
	await page.goto(url, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#agent-personality-profile")).toContainText(
		"Agent's own voice"
	);
	await page.screenshot({
		path: test.info().outputPath("agent-profile-own-voice-readback.png"),
		fullPage: true,
	});
	await writeFile(
		test.info().outputPath("agent-profile-requests.json"),
		JSON.stringify(await snapshot(page), null, 2)
	);
	expect(errors).toEqual([]);
});
