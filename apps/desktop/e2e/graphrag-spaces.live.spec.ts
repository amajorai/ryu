import { expect, test } from "@playwright/test";
import { z } from "zod";
import { retrievalModeStatusWireSchema } from "../src/lib/api/spaces-wire-contracts.ts";

const graphProgressSchema = retrievalModeStatusWireSchema
	.extend({
		graph_edges: z.number().optional(),
		graph_nodes: z.number().optional(),
	})
	.nullable();

const CORE_URL = "http://127.0.0.1:17980";
const NODE_TOKEN = "graphrag-e2e-node-token-2026-08-23";

interface GraphProgressCapture {
	completedStatus: z.output<typeof graphProgressSchema>;
}

test.describe.configure({ timeout: 900_000 });

test("switches a seeded Space to Graph and finds a multi-hop target", async ({
	page,
}) => {
	const rebuildStates: string[] = [];
	const browserErrors: string[] = [];
	const progress: GraphProgressCapture = {
		completedStatus: null,
	};
	let spaceId: string | null = null;
	page.on("pageerror", (error) =>
		browserErrors.push(`pageerror: ${error.message}`)
	);
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(`console: ${message.text()}`);
		}
	});
	page.on("requestfailed", (request) => {
		browserErrors.push(
			`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown"}`
		);
	});
	page.on("response", async (response) => {
		if (!response.url().includes("/retrieval-mode/status")) {
			return;
		}
		const body = graphProgressSchema.parse(await response.json());
		if (body?.state) {
			rebuildStates.push(body.state);
			if (body.state === "completed") {
				progress.completedStatus = body;
			}
		}
	});

	try {
		await page.goto("/graphrag-spaces-live.html");
		await expect(
			page.getByRole("heading", { name: "GraphRAG live Core proof" })
		).toBeVisible();
		await expect(page.getByText("Live Core seeded 48 documents")).toBeVisible({
			timeout: 120_000,
		});
		spaceId = await page.getByTestId("live-space-id").textContent();
		await expect(page.getByText("Alice and Acme")).toBeVisible();
		await expect(page.getByText("Acme location")).toBeVisible();
		await expect(page.getByText("Paris landmark")).toBeVisible();

		await page.getByLabel("Search query").fill("Alice");
		await page.getByRole("button", { exact: true, name: "Search" }).click();
		await expect(page.getByText(/^decoy\d+$/).first()).toBeVisible();
		await expect(page.getByText("Paris has the Eiffel Tower.")).toHaveCount(0);

		const vectorMode = page.getByRole("radio", {
			name: /Quick search|Vector/,
		});
		const graphMode = page.getByRole("radio", {
			name: /Connected search|Graph/,
		});
		await expect(vectorMode).toBeChecked();
		await graphMode.click();
		await expect(graphMode).toBeChecked({ timeout: 120_000 });
		await expect(
			page.getByText(/Graph retrieval is on\. Mapped/)
		).toBeVisible();
		await expect
			.poll(() => rebuildStates, { timeout: 30_000 })
			.toContain("completed");
		const completedStatus = progress.completedStatus;
		expect(completedStatus).not.toBeNull();
		expect(completedStatus?.processed_chunks).toBe(48);
		expect(completedStatus?.total_chunks).toBe(48);
		expect(completedStatus?.graph_nodes).toBeGreaterThan(0);
		expect(completedStatus?.graph_edges).toBeGreaterThan(0);

		await page.getByRole("button", { exact: true, name: "Search" }).click();
		const multiHopResult = page.getByText("Paris has the Eiffel Tower.");
		await expect(multiHopResult).toBeVisible({ timeout: 30_000 });
		await expect(
			page.getByText("Connected graph ready · 48/48 chunks")
		).toBeVisible();
		await multiHopResult.scrollIntoViewIfNeeded();
		expect(browserErrors).toEqual([]);
		await page.screenshot({
			path: test.info().outputPath("graphrag-live-proof.png"),
			fullPage: true,
		});
	} finally {
		if (spaceId) {
			const cleanup = await page.request.delete(
				`${CORE_URL}/api/spaces/${encodeURIComponent(spaceId)}`,
				{ headers: { authorization: `Bearer ${NODE_TOKEN}` } }
			);
			expect(cleanup.ok()).toBe(true);
		}
	}
});
