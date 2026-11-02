import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { parseCloudEnvironmentState } from "@ryuhq/protocol/cloud-environments";
import { z } from "zod";
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

test("real Core store saves and reloads published settings and sealed vault metadata", async ({
	page,
}) => {
	const core = "http://127.0.0.1:5250";
	const name = `Verified cloud ${Date.now()}`;
	const secret = `proof-secret-${Date.now()}`;
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(
		`/cloud-environments-proof.html?core=${encodeURIComponent(core)}`
	);
	await page
		.getByRole("button", { name: "Create environment", exact: true })
		.click();
	await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
	await page
		.getByRole("textbox", { name: "Install script", exact: true })
		.fill("printf 'prepared\\n'");
	await page
		.getByRole("textbox", { name: "Start instructions", exact: true })
		.fill("Use this cloud workspace for the task.");
	await page.getByRole("button", { name: "Publish", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page
		.getByRole("button", { name: "Personal vault", exact: true })
		.click();
	await page.getByRole("button", { name: "Add", exact: true }).click();
	await page
		.getByRole("textbox", { name: "Key", exact: true })
		.fill("PROOF_NETWORK_SECRET");
	await page.getByLabel("Value", { exact: true }).fill(secret);
	await page
		.getByRole("combobox", { name: "Type", exact: true })
		.selectOption("networkSecret");
	await page
		.getByRole("textbox", { name: "Allowed domains", exact: true })
		.fill("api.example.com");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.reload();
	await page
		.getByRole("button", { name: "Personal vault", exact: true })
		.click();
	await expect(
		page.getByText("PROOF_NETWORK_SECRET", { exact: true })
	).toBeVisible();
	await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
	const response = await page.request.get(`${core}/api/cloud-environments`, {
		headers: {
			authorization: "Bearer proof-node-token",
			"x-ryu-user-jwt": "cloud-proof-user-identity",
		},
	});
	expect(response.ok()).toBe(true);
	const payload = await response.text();
	expect(payload).not.toContain(secret);
	const snapshot = parseCloudEnvironmentState(JSON.parse(payload));
	expect(
		snapshot.environments.some(
			(environment) => environment.name === name && environment.published
		)
	).toBe(true);
	expect(
		snapshot.vault.some(
			(entry) => entry.key === "PROOF_NETWORK_SECRET" && entry.hasValue
		)
	).toBe(true);
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-real-store-vault.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "Environments", exact: true }).click();
	await expect(page.getByText(name, { exact: true })).toBeVisible();
	await page.screenshot({
		path: path.join(proofDirectory, "cloud-real-store-published.png"),
		fullPage: true,
		animations: "disabled",
	});
	expect(errors).toEqual([]);
	await writeFile(
		path.join(proofDirectory, "real-store-browser.json"),
		JSON.stringify(
			{
				scope:
					"Production settings component and real Core module/store; synthetic local test identity; no mocked API responses",
				revision: snapshot.revision,
				errors,
			},
			null,
			2
		)
	);
});

test("smoke renders the real cloud settings component", async ({ page }) => {
	await mkdir(proofDirectory, { recursive: true });
	const pending = new Map<string, number>();
	const timings: { url: string; event: string; duration: number }[] = [];
	const started = Date.now();
	const errors: string[] = [];
	page.on("request", (request) => {
		pending.set(request.url(), Date.now());
		timings.push({
			url: request.url(),
			event: "request",
			duration: Date.now() - started,
		});
	});
	page.on("response", (response) => {
		const url = response.url();
		timings.push({
			url,
			event: `response ${response.status()}`,
			duration: Date.now() - (pending.get(url) ?? started),
		});
		pending.delete(url);
	});
	page.on("requestfailed", (request) => {
		errors.push(`${request.url()}: ${request.failure()?.errorText}`);
		pending.delete(request.url());
	});
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(message.text());
		}
	});
	await installFixture(page);
	const interval = setInterval(() => {
		process.stdout.write(
			`Cloud proof pending ${JSON.stringify([...pending].map(([url, time]) => ({ url, elapsed: Date.now() - time })))}\n`
		);
	}, 10_000);
	try {
		await page.goto("/cloud-environments-proof.html", {
			waitUntil: "commit",
			timeout: 180_000,
		});
		await expect(
			page.getByRole("button", { name: "Create environment", exact: true })
		).toBeVisible({ timeout: 60_000 });
		await page.screenshot({
			path: path.join(proofDirectory, "cloud-environments-smoke.png"),
			fullPage: true,
			animations: "disabled",
			timeout: 15_000,
		});
	} finally {
		clearInterval(interval);
		await writeFile(
			path.join(proofDirectory, "resource-timing.json"),
			JSON.stringify({ errors, timings, pending: [...pending] }, null, 2)
		);
		process.stdout.write(`Cloud proof errors ${JSON.stringify(errors)}\n`);
	}
});
