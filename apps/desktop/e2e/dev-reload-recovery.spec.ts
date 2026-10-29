import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { z } from "zod";
import type { runSummarySchema } from "../src/lib/api/run-wire-contracts.ts";

const proofDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/dev-reload-recovery"
);
const story = "/dev-reload-recovery-proof.html";

test("reload recovers every interrupted dev chat once and leaves surviving and stopped turns alone", async ({
	page,
}) => {
	const runs: z.output<typeof runSummarySchema>[] = [
		{ id: "ui", title: "Build the interface", run_status: "running" },
		{ id: "core", title: "Update the runtime", run_status: "running" },
		{ id: "live", title: "Review the changes", run_status: "running" },
		{ id: "stop", title: "Paused by you", run_status: "running" },
		{ id: "done", title: "Documentation", run_status: "completed" },
	].map((run) => ({
		...run,
		agent_id: null,
		branch: null,
		created_at: 0,
		folder_path: null,
		message_count: 0,
		updated_at: 0,
		worktree_path: null,
	}));
	const retries: string[] = [];
	let rejectRetries = false;
	const events: string[] = [];
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	await page.route("**/api/health", (route) =>
		route.fulfill({ json: { status: "ok" } })
	);
	await page.route("**/api/runs", (route) => route.fulfill({ json: { runs } }));
	await page.route("**/api/chat/retry/*", (route) => {
		const id = route.request().url().split("/").at(-1) ?? "";
		retries.push(id);
		if (rejectRetries) {
			events.push(`retry rejected ${id}`);
			return route.fulfill({
				status: 503,
				json: { error: "Runtime warming up" },
			});
		}
		events.push(`retry ${id} ${route.request().postData()}`);
		const run = runs.find((candidate) => candidate.id === id);
		if (run) {
			run.run_status = "running";
		}
		return route.fulfill({ json: { started: true } });
	});
	await page.route("**/api/chat/cancel/*", (route) => {
		const id = route.request().url().split("/").at(-1);
		const run = runs.find((candidate) => candidate.id === id);
		if (run) {
			run.run_status = "interrupted";
		}
		events.push(`explicit stop ${id}`);
		return route.fulfill({ json: { cancelled: true } });
	});
	await page.goto(story);
	await expect(page.getByTestId("run-ui")).toContainText("Agent is working");
	await expect
		.poll(() =>
			page.evaluate(() => {
				const raw = localStorage.getItem(
					`ryu:reconnect-retry:${location.origin}`
				);
				return raw ? JSON.parse(raw).length : 0;
			})
		)
		.toBe(4);
	await page.getByRole("button", { name: "Stop Paused by you" }).click();
	await expect(page.getByTestId("run-stop")).toContainText("Turn interrupted");
	await expect
		.poll(() =>
			page.evaluate(() => {
				const raw = localStorage.getItem(
					`ryu:reconnect-retry:${location.origin}`
				);
				return raw
					? JSON.parse(raw).some(
							(candidate: { conversationId: string }) =>
								candidate.conversationId === "stop"
						)
					: false;
			})
		)
		.toBe(false);
	runs[0].run_status = "interrupted";
	runs[1].run_status = "interrupted";
	events.push("runtime interrupted ui and core while Desktop reloads");
	await page.reload();
	await expect.poll(() => [...retries].sort()).toEqual(["core", "ui"]);
	await expect(page.getByTestId("run-ui")).toContainText("Agent is working");
	await expect(page.getByTestId("run-core")).toContainText("Agent is working");
	await expect(page.getByTestId("run-live")).toContainText("Agent is working");
	await expect(page.getByTestId("run-stop")).toContainText("Turn interrupted");
	await expect(page.getByTestId("run-done")).toContainText("Task complete");
	await expect(page.getByTestId("reconnect-retry-status")).toContainText(
		"2 chats are running again"
	);
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "recovered-after-reload.png"),
		fullPage: true,
	});
	runs[0].run_status = "interrupted";
	runs[1].run_status = "failed";
	await page.reload();
	await expect.poll(() => retries.length).toBe(4);
	await expect(page.getByTestId("run-ui")).toContainText("Agent is working");
	await expect(page.getByTestId("run-core")).toContainText("Agent is working");
	events.push(
		"a second genuine runtime restart recovered both working chats again"
	);
	rejectRetries = true;
	runs[0].run_status = "failed";
	runs[1].run_status = "failed";
	await page.reload();
	await expect.poll(() => retries.length).toBe(6);
	await expect(page.getByTestId("dev-reload-recovery-proof")).toHaveAttribute(
		"data-phase",
		"error"
	);
	await page.reload();
	await expect(page.getByTestId("run-core")).toContainText("Turn interrupted");
	await expect(page.getByTestId("dev-reload-recovery-proof")).toHaveAttribute(
		"data-phase",
		"idle"
	);
	expect([...retries].sort()).toEqual([
		"core",
		"core",
		"core",
		"ui",
		"ui",
		"ui",
	]);
	expect(browserErrors).toEqual([]);
	events.push(
		"second reload did not repeat claimed retries; live/stopped/completed never retried"
	);
	await writeFile(
		path.join(proofDir, "browser-verification.json"),
		JSON.stringify({ events, retries, browserErrors }, null, 2)
	);
});
