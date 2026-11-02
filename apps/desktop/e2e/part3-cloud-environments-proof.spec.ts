// Continues cloud-environments-proof.spec.ts (split under the file token limit); helpers live in cloud-environments-proof.helpers.ts.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import type { CloudGithubConnection } from "../src/lib/api/cloud-github.ts";
import {
	browserLog,
	installFixture,
	proofDirectory,
} from "./cloud-environments-proof.helpers.ts";

test.beforeEach(async () => {
	const manifest = z
		.record(z.string(), z.string())
		.parse(
			JSON.parse(
				await readFile(
					path.resolve(
						"../../target/cloud-environments-proof-build/source-hashes.json"
					),
					"utf8"
				)
			)
		);
	for (const [file, hash] of Object.entries(manifest)) {
		expect(
			createHash("sha256")
				.update(await readFile(path.resolve("../..", file)))
				.digest("hex"),
			`Proof build is stale for ${file}`
		).toBe(hash);
	}
	await mkdir(proofDirectory, { recursive: true });
	await writeFile(
		path.join(proofDirectory, "ui-build-inputs.json"),
		JSON.stringify(manifest, null, 2)
	);
});

test.afterEach(async ({ page }, testInfo) => {
	await mkdir(proofDirectory, { recursive: true });
	await writeFile(
		path.join(proofDirectory, "browser-log.json"),
		JSON.stringify(browserLog, null, 2)
	);
	if (testInfo.status !== testInfo.expectedStatus) {
		await page.screenshot({
			path: path.join(proofDirectory, "cloud-proof-failure.png"),
			fullPage: true,
			animations: "disabled",
		});
	}
});

test("cloud task chooser verifies GitHub, creates a repository environment and sends only its ID", async ({
	page,
}) => {
	const fixture = await installFixture(page);
	const baseEnvironment = {
		id: "published-native",
		name: "Cloud project",
		repositories: ["fixture-owner/project"],
		installScript: "fixture-install-content",
		startInstructions: "fixture-start-content",
		internet: {
			enabled: true,
			domainPolicy: "all" as const,
			allowedDomains: [],
		},
		privacy: "private" as const,
		vaultKeys: [],
		tailscaleVaultKey: null,
		published: true,
	};
	fixture.setSnapshot({
		...fixture.getSnapshot(),
		environments: [
			baseEnvironment,
			{
				...baseEnvironment,
				id: "hidden-draft",
				name: "Unpublished draft",
				published: false,
			},
		],
	});
	let connection: CloudGithubConnection = {
		connected: false,
		login: null,
		vaultKey: null,
		repositories: [],
	};
	await page.route("**/api/cloud-environments/github", async (route) => {
		if (route.request().method() === "POST") {
			expect(route.request().postDataJSON()).toEqual({
				token: "fixture-token-verified-by-core",
				revision: fixture.getSnapshot().revision,
			});
			connection = {
				connected: true,
				login: "verified-owner",
				vaultKey: "GITHUB_TOKEN",
				repositories: [
					{ fullName: "verified-owner/private-repo", private: true },
				],
			};
			fixture.setSnapshot({
				...fixture.getSnapshot(),
				revision: fixture.getSnapshot().revision + 1,
				vault: [
					...fixture.getSnapshot().vault,
					{
						id: "github-credential",
						key: "GITHUB_TOKEN",
						kind: "networkSecret",
						domains: ["github.com", "api.github.com"],
						environmentIds: [],
						hasValue: true,
					},
				],
			});
		}
		await route.fulfill({
			json: { ...connection, state: fixture.getSnapshot() },
		});
	});
	const sent: unknown[] = [];
	await page.route("**/api/chat/stream", async (route) => {
		sent.push(route.request().postDataJSON());
		const chunks = [
			{ type: "start", messageId: "cloud-answer" },
			{ type: "text-start", id: "answer" },
			{
				type: "text-delta",
				id: "answer",
				delta: "Cloud task request accepted.",
			},
			{ type: "text-end", id: "answer" },
			{ type: "finish" },
		];
		await route.fulfill({
			headers: {
				"content-type": "text/event-stream",
				"x-vercel-ai-ui-message-stream": "v1",
			},
			body:
				chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
				"data: [DONE]\n\n",
		});
	});
	await page.goto("/cloud-environments-proof.html?task=1");
	await expect(
		page.getByRole("button", { name: "Use cloud", exact: true })
	).toBeEnabled();
	await page
		.getByRole("textbox", { name: "Task message" })
		.fill("Inspect the prepared repository.");
	await page.getByRole("button", { name: "Use cloud", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Send task", exact: true })
	).toBeDisabled();
	await page.getByRole("button", { name: "Choose cloud environment" }).click();
	await expect(
		page.getByRole("button", { name: "Unpublished draft", exact: true })
	).toHaveCount(0);
	await page
		.getByRole("textbox", { name: "Search cloud environments", exact: true })
		.fill("missing");
	await expect(
		page.getByText("No matching environments.", { exact: true })
	).toBeVisible();
	await page
		.getByRole("textbox", { name: "Search cloud environments", exact: true })
		.fill("");
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-task-environment-picker.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page
		.getByRole("button", { name: "Connect GitHub", exact: true })
		.click();
	await page
		.getByLabel("GitHub personal access token", { exact: true })
		.fill("fixture-token-verified-by-core");
	await page
		.getByRole("button", { name: "Verify and connect", exact: true })
		.click();
	await expect(
		page.getByText("Connected as verified-owner", { exact: true })
	).toBeVisible();
	await expect(
		page.getByLabel("GitHub personal access token", { exact: true })
	).toHaveValue("");
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-github-verified-repositories.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page
		.getByRole("button", { name: /verified-owner\/private-repo/ })
		.click();
	await expect(
		page.getByRole("textbox", { name: "Repositories", exact: true })
	).toHaveValue("verified-owner/private-repo");
	await expect(
		page.getByRole("checkbox", { name: "GITHUB_TOKEN", exact: true })
	).toBeChecked();
	await page.getByRole("button", { name: "Publish", exact: true }).click();
	const profile = fixture
		.getSnapshot()
		.environments.find((environment) =>
			environment.repositories.includes("verified-owner/private-repo")
		);
	expect(profile?.vaultKeys).toEqual(["GITHUB_TOKEN"]);
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Close", exact: true })
		.click();
	await page.getByRole("button", { name: "Choose cloud environment" }).click();
	await page.getByRole("button", { name: "private-repo", exact: true }).click();
	await page
		.getByRole("combobox", { name: "Task agent" })
		.selectOption("custom-acp");
	await expect(
		page.getByRole("button", { name: "Send task", exact: true })
	).toBeDisabled();
	await expect(
		page.getByText(/Cloud tasks currently support the Ryu native agent/)
	).toBeVisible();
	await page.getByRole("combobox", { name: "Task agent" }).selectOption("ryu");
	await page.getByRole("button", { name: "Send task", exact: true }).click();
	await expect(
		page.getByText("Cloud task request accepted.", { exact: true })
	).toBeVisible();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toMatchObject({
		cloudEnvironmentId: profile?.id,
		agent_id: "ryu",
	});
	expect(JSON.stringify(sent[0])).not.toContain(
		"fixture-token-verified-by-core"
	);
	expect(JSON.stringify(sent[0])).not.toContain("fixture-install-content");
	expect(JSON.stringify(sent[0])).not.toContain("fixture-start-content");
	await expect(
		page.getByRole("button", { name: "Cloud", exact: true })
	).toBeDisabled();
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-task-request-handoff.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("reopened cloud chat retains its immutable environment binding", async ({
	page,
}) => {
	const fixture = await installFixture(page);
	fixture.setSnapshot({
		...fixture.getSnapshot(),
		environments: [
			{
				id: "bound-profile",
				name: "Bound project",
				repositories: [],
				installScript: "",
				startInstructions: "",
				internet: { enabled: true, domainPolicy: "all", allowedDomains: [] },
				privacy: "private",
				vaultKeys: [],
				tailscaleVaultKey: null,
				published: true,
			},
		],
	});
	await page.route(
		"**/api/cloud-environments/task-binding/existing-chat",
		(route) =>
			route.fulfill({
				json: { cloudEnvironmentId: "bound-profile", state: "completed" },
			})
	);
	await page.goto(
		"/cloud-environments-proof.html?task=1&conversation=existing-chat"
	);
	await expect(
		page.getByRole("button", { name: "Cloud", exact: true })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Choose cloud environment" })
	).toContainText("Bound project");
	await page.getByRole("button", { name: "Choose cloud environment" }).click();
	await expect(
		page.getByRole("button", { name: "Bound project", exact: true })
	).toBeDisabled();
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-task-immutable-binding.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("changing the target retains cloud intent and requires a new environment choice", async ({
	page,
}) => {
	const fixture = await installFixture(page);
	fixture.setSnapshot({
		...fixture.getSnapshot(),
		environments: [
			{
				id: "first-node-profile",
				name: "First node cloud",
				repositories: [],
				installScript: "",
				startInstructions: "",
				internet: { enabled: true, domainPolicy: "all", allowedDomains: [] },
				privacy: "private",
				vaultKeys: [],
				tailscaleVaultKey: null,
				published: true,
			},
		],
	});
	await page.goto("/cloud-environments-proof.html?task=1");
	await expect(
		page.getByRole("button", { name: "Use cloud", exact: true })
	).toBeEnabled();
	await page.getByRole("button", { name: "Use cloud", exact: true }).click();
	await page.getByRole("button", { name: "Choose cloud environment" }).click();
	await page
		.getByRole("button", { name: "First node cloud", exact: true })
		.click();
	await page
		.getByRole("textbox", { name: "Task message" })
		.fill("Run this in the selected cloud environment.");
	await expect(
		page.getByRole("button", { name: "Send task", exact: true })
	).toBeEnabled();
	await page.evaluate(() =>
		window.dispatchEvent(new Event("cloud-proof-switch-target"))
	);
	await expect(
		page.getByRole("button", { name: "Cloud", exact: true })
	).toBeEnabled();
	await expect(
		page.getByRole("button", { name: "Choose cloud environment" })
	).toContainText("Choose environment");
	await expect(
		page.getByRole("button", { name: "Send task", exact: true })
	).toBeDisabled();
	await expect(
		page.getByText("Choose a published cloud environment before sending.", {
			exact: true,
		})
	).toBeVisible();
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-task-target-switch.png"),
		fullPage: true,
		animations: "disabled",
	});
});
