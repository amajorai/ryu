// Continues calendar-companion-proof.spec.ts (split under the file token limit); helpers live in calendar-companion-proof.helpers.ts.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	coreRequest,
	evidenceDir,
	fixtureState,
	job,
	mountCalendar,
} from "./calendar-companion-proof.helpers.ts";

test.beforeAll(async () => {
	await mkdir(evidenceDir, { recursive: true });
});

test("invalid custom cron stays editable after backend rejection and a corrected retry persists", async ({
	page,
}) => {
	const serverMessage = "Invalid cron expression: expected 5 fields.";
	const calendar = await mountCalendar(page, {
		createError: serverMessage,
		createFailuresRemaining: 1,
	});
	await calendar
		.getByRole("button", { name: "New automation", exact: true })
		.last()
		.click();
	const dialog = calendar.getByRole("dialog");
	await dialog.getByLabel("Schedule", { exact: true }).selectOption("custom");
	const createButton = dialog.getByRole("button", {
		name: "Create automation",
	});
	await createButton.click();
	await expect(
		dialog.getByText("Enter a cron expression.", { exact: true })
	).toBeVisible();
	expect(
		coreRequest(await fixtureState(page), "POST", "/heartbeat/jobs")
	).toHaveLength(0);

	const cronInput = dialog.getByLabel("Cron expression (UTC)");
	await cronInput.fill("61 * * * *");
	await createButton.click();
	await expect(dialog.getByText(serverMessage, { exact: true })).toBeVisible();
	await expect(dialog).toBeVisible();
	await expect(cronInput).toHaveValue("61 * * * *");
	await expect(createButton).toBeEnabled();
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "calendar-invalid-cron-recoverable.png"),
	});

	await cronInput.fill("*/15 * * * *");
	await createButton.click();
	await expect(dialog).not.toBeVisible();
	const saved = await fixtureState(page);
	expect(coreRequest(saved, "POST", "/heartbeat/jobs")).toHaveLength(2);
	expect(saved.jobs).toHaveLength(1);
	expect(saved.jobs[0]?.schedule).toEqual({
		kind: "cron",
		expr: "*/15 * * * *",
	});
});

test("failed initial load exposes retry and refresh updates the visible run list", async ({
	page,
}) => {
	const initialJob = job(
		"routine-before",
		"Previous routine",
		{ type: "agent", agent_id: "agent-analyst", prompt: "Run" },
		{ kind: "every", interval: "1d" }
	);
	const calendar = await mountCalendar(page, {
		jobs: [initialJob],
		jobReadFailuresRemaining: 1,
	});
	await expect(
		calendar.getByText("Could not load calendar", { exact: true })
	).toBeVisible();
	await calendar.getByRole("button", { name: "Try again" }).click();
	await expect(
		calendar.getByRole("button", { name: /Previous routine/ }).first()
	).toBeVisible();
	const afterRetry = await fixtureState(page);
	expect(coreRequest(afterRetry, "GET", "/heartbeat/jobs")).toHaveLength(2);

	const updatedJob = job(
		"routine-after",
		"Updated persisted routine",
		{ type: "agent", agent_id: "agent-analyst", prompt: "Run" },
		{ kind: "every", interval: "1d" }
	);
	const replace = await page.evaluate(
		async (serializedJobs) => {
			const response = await fetch("/__proof/replace-jobs", {
				body: serializedJobs,
				headers: { "Content-Type": "application/json" },
				method: "POST",
			});
			return response.ok;
		},
		JSON.stringify({ jobs: [updatedJob] })
	);
	expect(replace).toBe(true);
	await calendar.getByRole("button", { name: "Refresh" }).click();
	await expect(
		calendar.getByRole("button", { name: /Updated persisted routine/ }).first()
	).toBeVisible();
	await expect(
		calendar.getByRole("button", { name: /Previous routine/ })
	).toHaveCount(0);
	const refreshed = await fixtureState(page);
	expect(coreRequest(refreshed, "GET", "/heartbeat/jobs")).toHaveLength(3);
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "calendar-load-retry-refresh-result.png"),
	});
});
