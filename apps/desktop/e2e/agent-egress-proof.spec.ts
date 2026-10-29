import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	type AgentEgressSnapshot,
	agentEgressSnapshotSchema,
} from "./agent-egress-proof.contracts.ts";

const PROOF_DIRECTORY = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

function screenshotPath(name: string): string {
	return path.join(PROOF_DIRECTORY, name);
}

async function readProof(page: Page): Promise<AgentEgressSnapshot> {
	return agentEgressSnapshotSchema.parse(
		await page.evaluate(() => {
			const proof = window.__agentEgressProof;
			if (!proof) {
				throw new Error("Agent egress fixture is not installed");
			}
			return proof.snapshot();
		})
	);
}

async function openSettings(page: Page, query = ""): Promise<void> {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	await page.goto(`/agent-egress-proof.html${query}`);
	try {
		await expect(page.locator('body[data-harness-ready="1"]')).toBeVisible();
	} catch (error) {
		throw new Error(
			`Agent egress proof did not mount${browserErrors.length > 0 ? `: ${browserErrors.join("; ")}` : "."}`,
			{ cause: error }
		);
	}
	await expect(
		page
			.getByRole("region", { name: "Agent egress settings proof" })
			.getByRole("heading", { name: "Agent tools and model traffic" })
	).toBeVisible();
}

test.describe.configure({ timeout: 60_000 });

test("a failed settings load has an explicit retry and recovers the agent list", async ({
	page,
}) => {
	await openSettings(page, "?readFailure=1");
	await expect(
		page.getByText("Could not read this node's agent settings", {
			exact: false,
		})
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Review changes" })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Retry", exact: true })
	).toBeVisible();
	const unavailable = await readProof(page);
	expect(
		unavailable.requests.some(
			(request) => request.method === "GET" && request.status === 503
		)
	).toBe(true);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("desktop-agent-egress-read-unavailable.png"),
	});

	await page.evaluate(() => {
		const proof = window.__agentEgressProof;
		if (!proof) {
			throw new Error("Agent egress fixture is not installed");
		}
		return proof.setReadFailure(false);
	});
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Review changes" })
	).toBeVisible();
	await expect(
		page.getByRole("switch", { name: "Give Claude Code access to Ryu's tools" })
	).toBeVisible();
	const recovered = await readProof(page);
	expect(recovered.requests.some((request) => request.status === 200)).toBe(
		true
	);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("desktop-agent-egress-read-recovered.png"),
	});
});

test("tool and model-traffic switches persist independently and a failed preference can be retried", async ({
	page,
}) => {
	await openSettings(page);
	const tools = page.getByRole("switch", {
		name: "Give Claude Code access to Ryu's tools",
	});
	const modelTraffic = page.getByRole("switch", {
		name: "Send Claude Code's model calls through the gateway",
	});
	await expect(tools).not.toBeChecked();
	await expect(modelTraffic).not.toBeChecked();
	await expect(
		page.getByText("Straight to provider", { exact: true }).first()
	).toBeVisible();
	await expect(
		page.getByText("Ryu tools off", { exact: true }).first()
	).toBeVisible();

	await page.evaluate(() => {
		const proof = window.__agentEgressProof;
		if (!proof) {
			throw new Error("Agent egress fixture is not installed");
		}
		return proof.failNextWrite("/api/preferences/agent-tool-bridge");
	});
	await tools.click();
	await expect(
		page.getByText("Could not save that. The node still has the old setting.", {
			exact: true,
		})
	).toBeVisible();
	await expect(tools).not.toBeChecked();
	await expect(modelTraffic).not.toBeChecked();
	let state = await readProof(page);
	expect(state.preferences["agent-tool-bridge"]).toBe(
		JSON.stringify({
			"acp:claude": false,
			"research-agent": false,
			openclaw: false,
		})
	);

	await tools.click();
	await expect(tools).toBeChecked();
	await expect(
		page.getByText("Tools on in new chats", { exact: true })
	).toBeVisible();
	await expect(modelTraffic).not.toBeChecked();
	state = await readProof(page);
	expect(state.preferences["agent-tool-bridge"]).toBe(
		JSON.stringify({
			"acp:claude": true,
			"research-agent": false,
			openclaw: false,
		})
	);

	await page.evaluate(() => {
		const proof = window.__agentEgressProof;
		if (!proof) {
			throw new Error("Agent egress fixture is not installed");
		}
		return proof.failNextWrite("/api/preferences/claude-gateway-routing");
	});
	await modelTraffic.click();
	await expect(
		page.getByText("Could not save that. The node still has the old setting.", {
			exact: true,
		})
	).toBeVisible();
	await expect(modelTraffic).not.toBeChecked();
	await expect(tools).toBeChecked();
	await modelTraffic.click();
	await expect(modelTraffic).toBeChecked();
	await expect(
		page.getByText("Gateway on next start", { exact: true })
	).toBeVisible();
	await expect(tools).toBeChecked();
	state = await readProof(page);
	expect(state.preferences["claude-gateway-routing"]).toBe("true");
	expect(state.preferences["agent-tool-bridge"]).toBe(
		JSON.stringify({
			"acp:claude": true,
			"research-agent": false,
			openclaw: false,
		})
	);
	expect(
		state.requests
			.filter((request) => request.method === "PUT")
			.map(({ authorization, body, path, status }) => ({
				authorization,
				body,
				path,
				status,
			}))
	).toEqual([
		{
			authorization: "Bearer agent-egress-proof-token",
			body: {
				value: JSON.stringify({
					"acp:claude": true,
					"research-agent": false,
					openclaw: false,
				}),
			},
			path: "/api/preferences/agent-tool-bridge",
			status: 503,
		},
		{
			authorization: "Bearer agent-egress-proof-token",
			body: {
				value: JSON.stringify({
					"acp:claude": true,
					"research-agent": false,
					openclaw: false,
				}),
			},
			path: "/api/preferences/agent-tool-bridge",
			status: 200,
		},
		{
			authorization: "Bearer agent-egress-proof-token",
			body: { value: "true" },
			path: "/api/preferences/claude-gateway-routing",
			status: 503,
		},
		{
			authorization: "Bearer agent-egress-proof-token",
			body: { value: "true" },
			path: "/api/preferences/claude-gateway-routing",
			status: 200,
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("desktop-agent-egress-switches-persisted.png"),
	});
	await page.reload();
	await expect(
		page.getByRole("switch", { name: "Give Claude Code access to Ryu's tools" })
	).toBeChecked();
	await expect(
		page.getByRole("switch", {
			name: "Send Claude Code's model calls through the gateway",
		})
	).toBeChecked();
});

test("bulk tool plan previews exact changes, cancel is read-only, failure retries, and readback is idempotent", async ({
	page,
}) => {
	await openSettings(page);
	await page.getByRole("button", { name: "Review changes" }).click();
	const plan = page.getByText("Will turn Ryu's tools on for 3 agents:", {
		exact: true,
	});
	await expect(plan).toBeVisible();
	await expect(
		page.getByText("Claude Code — off → on", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Research Agent — off → on", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("OpenClaw — off → on", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Leaves 3 agents alone:", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText(/Model traffic is not changed for any agent/)
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("desktop-agent-egress-tools-plan-review.png"),
	});
	let state = await readProof(page);
	expect(state.requests.filter((request) => request.method === "PUT")).toEqual(
		[]
	);
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(plan).toHaveCount(0);
	state = await readProof(page);
	expect(state.requests.filter((request) => request.method === "PUT")).toEqual(
		[]
	);

	await page.getByRole("button", { name: "Review changes" }).click();
	await page.evaluate(() => {
		const proof = window.__agentEgressProof;
		if (!proof) {
			throw new Error("Agent egress fixture is not installed");
		}
		return proof.holdNextWrite("/api/preferences/agent-tool-bridge");
	});
	const apply = page.getByRole("button", {
		name: "Turn tools on",
		exact: true,
	});
	await apply.click();
	const applying = page.getByRole("button", { name: "Applying…", exact: true });
	await expect(applying).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Cancel", exact: true })
	).toBeDisabled();
	state = await readProof(page);
	expect(state.requests.at(-1)).toMatchObject({
		method: "PUT",
		path: "/api/preferences/agent-tool-bridge",
		status: null,
	});
	await page.evaluate(() => {
		const proof = window.__agentEgressProof;
		if (!proof) {
			throw new Error("Agent egress fixture is not installed");
		}
		return proof.releaseHeldWrite(true);
	});
	await expect(
		page.getByText(
			"Could not save that. The node still has the old settings.",
			{ exact: true }
		)
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Turn tools on", exact: true })
	).toBeEnabled();
	state = await readProof(page);
	expect(state.preferences["agent-tool-bridge"]).toBe(
		JSON.stringify({
			"acp:claude": false,
			"research-agent": false,
			openclaw: false,
		})
	);

	await page
		.getByRole("button", { name: "Turn tools on", exact: true })
		.click();
	await expect(
		page.getByText(/Turned Ryu's tools on for 3 agents\./)
	).toBeVisible();
	state = await readProof(page);
	const bulkWrites = state.requests.filter(
		(request) =>
			request.method === "PUT" &&
			request.path === "/api/preferences/agent-tool-bridge"
	);
	expect(bulkWrites.map(({ body, status }) => ({ body, status }))).toEqual([
		{
			body: {
				value: JSON.stringify({
					"acp:claude": true,
					"research-agent": true,
					openclaw: true,
				}),
			},
			status: 503,
		},
		{
			body: {
				value: JSON.stringify({
					"acp:claude": true,
					"research-agent": true,
					openclaw: true,
				}),
			},
			status: 200,
		},
	]);
	expect(state.preferences["claude-gateway-routing"]).toBe("false");
	expect(state.preferences["agent-gateway-routing"]).toBe(
		JSON.stringify({ "research-agent": false })
	);
	expect(state.preferences["agent-tool-bridge"]).toBe(
		JSON.stringify({
			"acp:claude": true,
			"research-agent": true,
			openclaw: true,
		})
	);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("desktop-agent-egress-tools-plan-applied.png"),
	});

	await page.reload();
	await expect(
		page.getByText(/Turned Ryu's tools on for 3 agents\./)
	).toHaveCount(0);
	await page.getByRole("button", { name: "Review changes" }).click();
	await expect(
		page.getByText("Nothing to change.", { exact: false })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Turn tools on", exact: true })
	).toBeDisabled();
	state = await readProof(page);
	const finalBulkWrites = state.requests.filter(
		(request) =>
			request.method === "PUT" &&
			request.path === "/api/preferences/agent-tool-bridge"
	);
	expect(finalBulkWrites).toHaveLength(2);
});
