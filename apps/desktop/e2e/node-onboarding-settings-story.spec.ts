import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { NodeOnboardingSnapshot } from "../src/lib/api/onboarding-profile.ts";

const STORY_URL = "/node-onboarding-settings-story.html";
const EVIDENCE = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-gateway/evidence"
);
async function fixture(page: Page, denied = false) {
	const dir = await mkdtemp(path.join(tmpdir(), "ryu-node-reset-proof-"));
	const statePath = path.join(dir, "state.json");
	let state: NodeOnboardingSnapshot = {
		canConfigure: !denied,
		completed: true,
		completedAtMs: 1_788_339_063_780,
		personalization: {
			companyContext: "Reviewable tools",
			companyKnowledgeEnabled: true,
		},
		setupKind: "team",
		version: 1,
	};
	await writeFile(statePath, JSON.stringify(state));
	const calls: {
		method: string;
		authorization: string | undefined;
		body: string;
	}[] = [];
	let deletes = 0;
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) {
			body += chunk;
		}
		calls.push({
			method: req.method ?? "GET",
			authorization: req.headers.authorization,
			body,
		});
		if (req.method === "DELETE") {
			deletes++;
			if (deletes === 1) {
				res.writeHead(503, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "Retry reset proof" }));
				return;
			}
			state = {
				...state,
				completed: false,
				completedAtMs: null,
				setupKind: null,
				personalization: { companyContext: "", companyKnowledgeEnabled: false },
			};
			await writeFile(statePath, JSON.stringify(state));
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(state));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || isNativeText(address)) {
		throw new Error("No fixture port");
	}
	await page.route("**/api/onboarding/state", async (route) => {
		const response = await route.fetch({
			url: `http://127.0.0.1:${address.port}/api/onboarding/state`,
		});
		await route.fulfill({ response });
	});
	return {
		calls,
		read: async () => JSON.parse(await readFile(statePath, "utf8")),
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
test("reachable Gateway node reset retries failed DELETE, persists and reloads server state", async ({
	page,
}) => {
	const f = await fixture(page);
	try {
		await page.goto(STORY_URL);
		await expect(
			page.getByText("Node setup · Team or company", { exact: true })
		).toBeVisible();
		await page
			.getByRole("button", { name: "Reset onboarding", exact: true })
			.click();
		await expect
			.poll(() => f.calls.filter((c) => c.method === "DELETE").length)
			.toBe(1);
		await expect(
			page.getByRole("button", { name: "Reset onboarding", exact: true })
		).toBeEnabled();
		expect((await f.read()).completed).toBe(true);
		await page
			.getByRole("button", { name: "Reset onboarding", exact: true })
			.click();
		await expect(page.getByText("Needs setup", { exact: true })).toBeVisible();
		expect(await f.read()).toMatchObject({
			completed: false,
			completedAtMs: null,
			setupKind: null,
			personalization: { companyContext: "", companyKnowledgeEnabled: false },
		});
		const deletes = f.calls.filter((c) => c.method === "DELETE");
		expect(deletes).toHaveLength(2);
		for (const call of deletes) {
			expect(call).toEqual({
				method: "DELETE",
				authorization: "Bearer node-onboarding-proof-token",
				body: "",
			});
		}
		expect(
			f.calls.filter((c) => c.method === "GET").length
		).toBeGreaterThanOrEqual(2);
		await page.reload();
		await expect(page.getByText("Needs setup", { exact: true })).toBeVisible();
		await mkdir(EVIDENCE, { recursive: true });
		await page.screenshot({
			path: path.join(EVIDENCE, "node-onboarding-reset-persisted-readback.png"),
			fullPage: true,
		});
	} finally {
		await f.close();
	}
});
test("authoritative node permission disables reset despite broad parent capability", async ({
	page,
}) => {
	const f = await fixture(page, true);
	try {
		await page.goto(STORY_URL);
		await expect(
			page.getByRole("button", { name: "Reset onboarding", exact: true })
		).toBeDisabled();
		expect(f.calls.some((c) => c.method === "DELETE")).toBe(false);
	} finally {
		await f.close();
	}
});
