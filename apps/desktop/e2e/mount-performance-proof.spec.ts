import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";

async function proofDirectory(browserName: string) {
	const directory = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/performance-sweep",
		browserName === "chromium" ? "" : `${browserName}-mount`
	);
	await mkdir(directory, { recursive: true });
	return directory;
}

test("real companion bridge survives cosmetic renders and reconnects after document replacement", async ({
	page,
	browserName,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/mount-performance-proof.html");
	const frame = page.frameLocator('iframe[title="Warmup companion"]');
	await expect(
		frame.getByRole("heading", { name: "Warmup", exact: true })
	).toBeVisible();
	await expect(page.getByTestId("connections")).toHaveText("1");
	await frame.getByLabel("Ping message").fill("Keep this draft");
	await page
		.getByRole("button", { name: "Update appearance", exact: true })
		.click();
	await expect(frame.getByLabel("Ping message")).toHaveValue("Keep this draft");
	await expect(page.getByTestId("connections")).toHaveText("1");
	await page
		.getByRole("button", { name: "Replace document", exact: true })
		.click();
	await expect(page.getByTestId("connections")).toHaveText("2");
	await expect(
		frame.getByRole("heading", { name: "Warmup", exact: true })
	).toBeVisible();
	await expect(page.getByTestId("reads")).toHaveText("4");
	expect(errors).toEqual([]);
	const dir = await proofDirectory(browserName);
	await mkdir(dir, { recursive: true });
	await page.screenshot({
		path: path.join(dir, "mounting-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("records cold and repeat mounts through the actual sandbox host", async ({
	page,
	browserName,
}) => {
	await page.goto("/mount-performance-proof.html");
	const samples = async () =>
		z
			.array(
				z.object({
					version: z.number(),
					wrapperMs: z.number(),
					handshakeMs: z.number(),
					readyMs: z.number(),
				})
			)
			.parse(
				JSON.parse(
					(await page.getByTestId("mount-timings").textContent()) ?? "[]"
				)
			);
	await expect.poll(async () => (await samples()).length).toBe(1);
	for (let version = 2; version <= 6; version++) {
		await page
			.getByRole("button", { name: "Replace document", exact: true })
			.click();
		await expect.poll(async () => (await samples()).length).toBe(version);
	}
	const measured = await samples();
	for (const sample of measured) {
		expect(sample.readyMs).toBeGreaterThanOrEqual(sample.handshakeMs);
		expect(sample.handshakeMs).toBeGreaterThanOrEqual(sample.wrapperMs);
	}
	const sorted = measured
		.slice(1)
		.map((sample) => sample.readyMs)
		.sort((a, b) => a - b);
	const dir = await proofDirectory(browserName);
	await mkdir(dir, { recursive: true });
	await writeFile(
		path.join(dir, "mount-timings.json"),
		`${JSON.stringify({ scope: "Local production Warmup HTML through ExtensionHost; excludes Core bundle HTTP and packaged Tauri", cold: measured[0], repeatMedianReadyMs: sorted[Math.floor(sorted.length / 2)], samples: measured }, null, 2)}\n`
	);
});

test("closed companion cycles release frame documents and listeners", async ({
	page,
	browserName,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const cdp = await page.context().newCDPSession(page);
	await page.goto("/mount-performance-proof.html");
	const heading = () =>
		page
			.frameLocator('iframe[title="Warmup companion"]')
			.getByRole("heading", { name: "Warmup", exact: true });
	await expect(heading()).toBeVisible();
	const close = async () => {
		await page
			.getByRole("button", { name: "Close companion", exact: true })
			.click();
		await expect(page.locator("iframe")).toHaveCount(0);
		await cdp.send("HeapProfiler.collectGarbage");
		return await cdp.send("Memory.getDOMCounters");
	};
	const baseline = await close();
	const samples = [];
	for (let cycle = 1; cycle <= 12; cycle++) {
		await page
			.getByRole("button", { name: "Open companion", exact: true })
			.click();
		await expect(heading()).toBeVisible();
		await expect(page.getByTestId("connections")).toHaveText(String(cycle + 1));
		await expect(page.getByTestId("reads")).toHaveText(String((cycle + 1) * 2));
		const counters = await close();
		samples.push({ cycle, ...counters });
	}
	for (const sample of samples) {
		expect(sample.documents).toBeLessThanOrEqual(baseline.documents);
		expect(sample.nodes).toBeLessThanOrEqual(baseline.nodes);
		expect(sample.jsEventListeners).toBeLessThanOrEqual(
			baseline.jsEventListeners
		);
	}
	expect(errors).toEqual([]);
	const dir = await proofDirectory(browserName);
	await writeFile(
		path.join(dir, "mount-retained-resources.json"),
		`${JSON.stringify({ scope: "Chromium GC DOM counters for actual ExtensionHost and production Warmup bundle; controlled services, excludes packaged Tauri and whole-app heap", baseline, samples }, null, 2)}\n`
	);
	await page
		.getByRole("button", { name: "Open companion", exact: true })
		.click();
	await expect(heading()).toBeVisible();
	await page.screenshot({
		path: path.join(dir, "mount-retained-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("closing or replacing a companion aborts its pending own-app read", async ({
	page,
	browserName,
	request,
}) => {
	const state = async () =>
		await (await request.get("/proof-read-state")).json();
	const before = await state();
	await page.goto("/mount-performance-proof.html?pendingRead=1");
	const heading = page
		.frameLocator('iframe[title="Warmup companion"]')
		.getByRole("heading", { name: "Warmup", exact: true });
	await expect(heading).toBeVisible();
	await expect
		.poll(async () => (await state()).started - before.started)
		.toBe(1);
	await page
		.getByRole("button", { name: "Replace document", exact: true })
		.click();
	await expect(heading).toBeVisible();
	await expect.poll(async () => (await state()).closed - before.closed).toBe(1);
	await expect
		.poll(async () => (await state()).started - before.started)
		.toBe(2);
	await page
		.getByRole("button", { name: "Close companion", exact: true })
		.click();
	await expect.poll(async () => (await state()).closed - before.closed).toBe(2);
	await page
		.getByRole("button", { name: "Open companion", exact: true })
		.click();
	await expect(heading).toBeVisible();
	await expect
		.poll(async () => (await state()).started - before.started)
		.toBe(3);
	const dir = await proofDirectory(browserName);
	await page.screenshot({
		path: path.join(dir, "companion-read-lifetime-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page
		.getByRole("button", { name: "Close companion", exact: true })
		.click();
	await expect.poll(async () => (await state()).closed - before.closed).toBe(3);
});

test("completed plugin host stream closes its HTTP body through the companion bridge", async ({
	page,
	request,
	browserName,
}) => {
	const before = await (await request.get("/proof-host-stream-state")).json();
	await page.goto("/mount-performance-proof.html?hostStream");
	const frame = page.frameLocator('iframe[title="Warmup companion"]');
	await expect(
		frame.getByText("Stream complete: fixture reply", { exact: true })
	).toBeVisible();
	await expect
		.poll(
			async () =>
				(await (await request.get("/proof-host-stream-state")).json()).closed
		)
		.toBe(before.closed + 1);
	const after = await (await request.get("/proof-host-stream-state")).json();
	expect(after.started).toBe(before.started + 1);
	const directory = await proofDirectory(browserName);
	await page.screenshot({
		path: path.join(directory, "plugin-stream-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});
