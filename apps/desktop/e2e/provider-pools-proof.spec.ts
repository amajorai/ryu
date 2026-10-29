import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";

const nativeSocketAddressSchema = z.object({
	address: z.string(),
	family: z.string(),
	port: z.number(),
});
const gatewayRuntimeArtifactSchema = z.object({
	exe: z.string(),
	sha256: z.string(),
});

test.describe.configure({ timeout: 600_000 });

test("production Gateway persists real policy writes and dispatches only to loopback", async ({
	page,
}) => {
	const artifactPath = path.resolve(
		import.meta.dirname,
		"../../../.tmp/new-parity-final-gates/gateway-runtime-artifact.json"
	);
	const artifact = gatewayRuntimeArtifactSchema.parse(
		JSON.parse(await readFile(artifactPath, "utf8"))
	);
	const sha = (bytes: Uint8Array) =>
		createHash("sha256").update(bytes).digest("hex");
	expect(sha(await readFile(artifact.exe))).toBe(artifact.sha256);
	const proofRoot = path.resolve(
		import.meta.dirname,
		`../../../docs/proof/provider-pools/native-${Date.now()}`
	);
	await mkdir(proofRoot, { recursive: true });
	const upstreamModels: string[] = [];
	const upstream = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) {
			body += chunk.toString();
		}
		response.setHeader("Content-Type", "application/json");
		if (request.url?.endsWith("/models")) {
			response.end(
				JSON.stringify({
					object: "list",
					data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }],
				})
			);
			return;
		}
		const parsed = JSON.parse(body || "{}");
		upstreamModels.push(String(parsed.model));
		response.end(
			JSON.stringify({
				id: "loopback-routing-proof",
				object: "chat.completion",
				model: parsed.model,
				choices: [
					{
						index: 0,
						message: {
							role: "assistant",
							content: `Loopback Gateway response from ${parsed.model}`,
						},
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
			})
		);
	});
	await new Promise<void>((resolve) =>
		upstream.listen(0, "127.0.0.1", resolve)
	);
	const upstreamAddressResult = nativeSocketAddressSchema.safeParse(
		upstream.address()
	);
	if (!upstreamAddressResult.success) {
		throw new Error("No loopback upstream address");
	}
	const upstreamAddress = upstreamAddressResult.data;
	const reserve = createTcpServer();
	await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
	const gatewayAddressResult = nativeSocketAddressSchema.safeParse(
		reserve.address()
	);
	if (!gatewayAddressResult.success) {
		throw new Error("No Gateway fixture port");
	}
	const gatewayAddress = gatewayAddressResult.data;
	await new Promise<void>((resolve, reject) =>
		reserve.close((error) => (error ? reject(error) : resolve()))
	);
	const gatewayUrl = `http://127.0.0.1:${gatewayAddress.port}`;
	const key = "gwadmin_routing_ui_local_fixture_1234567890";
	const configPath = path.join(proofRoot, "gateway.toml");
	await writeFile(
		configPath,
		`bind = "127.0.0.1:${gatewayAddress.port}"\n[auth]\nrequire_auth = true\nmaster_key = "${key}"\n[providers.openai]\napi_key = "loopback-fixture-only"\nbase_url = "http://127.0.0.1:${upstreamAddress.port}/v1"\n[cache]\nenabled = false\n[routing]\ndefault_provider = "openai"\n[routing.model_map."balanced-chat"]\nprovider = "pool:balanced"\n[routing.provider_pools.balanced]\nstrategy = "round_robin"\n[[routing.provider_pools.balanced.members]]\nprovider = "openai"\nmodel = "gpt-4o-mini"\n[[routing.provider_pools.balanced.members]]\nprovider = "openai"\nmodel = "gpt-4o"\n`
	);
	const environment: NodeJS.ProcessEnv = {};
	for (const name of [
		"PATH",
		"Path",
		"SystemRoot",
		"WINDIR",
		"TEMP",
		"TMP",
		"COMSPEC",
		"PATHEXT",
	]) {
		if (process.env[name]) {
			environment[name] = process.env[name];
		}
	}
	Object.assign(environment, {
		RYU_PROFILE: "dev",
		RYU_KEYCHAIN: "off",
		RYU_DIR: path.join(proofRoot, "data"),
		USERPROFILE: proofRoot,
		APPDATA: proofRoot,
		LOCALAPPDATA: proofRoot,
		GATEWAY_CONFIG: configPath,
		GATEWAY_MASTER_KEY: key,
		RYU_DIAGNOSTICS_EXPORT_ENABLED: "0",
		RYU_CRASH_REPORTS_ENABLED: "0",
	});
	const runtime: ChildProcess = spawn(artifact.exe, [], {
		cwd: proofRoot,
		env: environment,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let runtimeLog = "";
	runtime.stdout?.on("data", (bytes) => {
		runtimeLog += bytes.toString();
	});
	runtime.stderr?.on("data", (bytes) => {
		runtimeLog += bytes.toString();
	});
	const headers = {
		Authorization: `Bearer ${key}`,
		"Content-Type": "application/json",
	};
	const transport: { method: string; path: string; status: number }[] = [];
	try {
		await expect
			.poll(
				async () => {
					try {
						return (await fetch(`${gatewayUrl}/health`, { headers })).status;
					} catch {
						return 0;
					}
				},
				{ timeout: 60_000 }
			)
			.toBe(200);
		await page.route("**/api/gateway/config", async (route) => {
			const request = route.request();
			const response = await fetch(`${gatewayUrl}/v1/config`, {
				method: request.method(),
				headers,
				body:
					request.method() === "GET"
						? undefined
						: (request.postData() ?? undefined),
			});
			transport.push({
				method: request.method(),
				path: "/v1/config",
				status: response.status,
			});
			await route.fulfill({
				status: response.status,
				contentType: "application/json",
				body: await response.text(),
			});
		});
		await page.route("**/proof/chat/completions", async (route) => {
			const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
				method: "POST",
				headers,
				body: route.request().postData() ?? undefined,
			});
			transport.push({
				method: "POST",
				path: "/v1/chat/completions",
				status: response.status,
			});
			await route.fulfill({
				status: response.status,
				contentType: "application/json",
				body: await response.text(),
			});
		});
		await page.goto("/provider-pools-proof.html?native", {
			waitUntil: "domcontentloaded",
		});
		await page.getByRole("button", { name: "Edit pool balanced" }).click();
		await page.getByLabel("Routing strategy").click();
		await expect(page.getByRole("option")).toHaveCount(21);
		await page.getByRole("option", { name: "Auto", exact: true }).click();
		await page
			.getByText("Advanced Auto scoring weights", { exact: true })
			.click();
		await page.getByRole("switch", { name: "Customize Auto weights" }).click();
		await page.getByLabel("Quality", { exact: true }).fill("1");
		await page.getByRole("button", { name: "Save pool" }).click();
		await expect(page.getByText("Auto · 2 active members")).toBeVisible();
		const saved = await (
			await fetch(`${gatewayUrl}/v1/config`, { headers })
		).json();
		expect(saved.routing.provider_pools.balanced.strategy).toBe("auto");
		expect(saved.routing.provider_pools.balanced.auto_weights.quality).toBe(1);
		expect(
			transport.some((entry) => entry.method === "PUT" && entry.status === 200)
		).toBe(true);
		await page.getByRole("button", { name: "Send loopback test" }).click();
		await expect(
			page.getByRole("status").filter({ hasText: "Loopback Gateway response" })
		).toBeVisible();
		expect(upstreamModels.length).toBeGreaterThan(0);
		const screenshot = path.join(
			proofRoot,
			"native-saved-policy-and-dispatch.png"
		);
		await page.screenshot({ path: screenshot, fullPage: true });
		await writeFile(
			path.join(proofRoot, "result.json"),
			JSON.stringify(
				{
					artifact,
					binarySha256After: sha(await readFile(artifact.exe)),
					actualConfigReadsWrites: transport,
					savedStrategy: saved.routing.provider_pools.balanced.strategy,
					upstreamModels,
					screenshot,
					scope:
						"Actual exported UI modules, actual production Gateway GET/PUT and loopback provider dispatch through a thin authenticated test transport bridge; no Core runtime claim or vendor calls.",
				},
				null,
				2
			)
		);
		expect(sha(await readFile(artifact.exe))).toBe(artifact.sha256);
	} finally {
		runtime.kill();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
		await writeFile(path.join(proofRoot, "runtime.log"), runtimeLog);
	}
});

test("creates a named direct provider pool and shows its routing strategy", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/provider-pools-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await expect(page.getByText("pool:balanced")).toBeVisible();
	await page.getByRole("button", { name: "Create pool" }).click();
	await page.getByLabel("Pool name").fill("overflow");
	await page.getByLabel("Cooldown wait (ms)").fill("750");
	await page.getByRole("button", { name: "Add provider" }).click();
	await page.getByLabel("Upstream model").first().fill("gpt-4o-mini");
	await page.getByRole("button", { name: "Add provider" }).click();
	await page.getByLabel("Upstream model").nth(1).fill("claude-haiku-4-5");
	await page.getByRole("switch", { name: "Last resort" }).nth(1).click();
	await expect(
		page.getByRole("switch", { name: "Last resort" }).nth(1)
	).toBeChecked();
	await page.getByLabel("Routing strategy").click();
	await expect(page.getByRole("option", { name: "Fill first" })).toBeVisible();
	await expect(
		page.getByRole("option", { name: "Weighted", exact: true })
	).toBeVisible();
	await expect(page.getByRole("option", { name: "Least used" })).toBeVisible();
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/provider-pools/provider-pools-strategies.png"
		),
		fullPage: true,
	});
	await page.getByRole("option", { name: "Weighted round robin" }).click();
	await page.keyboard.press("Escape");
	await page.getByLabel("Weight").nth(1).fill("2");
	await page.getByRole("heading", { name: "Provider pool routing" }).click();
	await expect(page.getByRole("option", { name: "Least used" })).toBeHidden();
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/provider-pools/provider-pools-editor.png"
		),
		fullPage: true,
	});
	await page.getByRole("button", { name: "Save pool" }).click();
	await expect(page.getByText("pool:overflow", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Weighted round robin · 2 active members")
	).toBeVisible();
	await expect(
		page.getByText(
			"Saved overflow. Map a chat model to pool:overflow, then restart Gateway."
		)
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Edit pool overflow" })
	).toBeEnabled();
	await page.getByRole("button", { name: "Edit pool balanced" }).click();
	await page.getByLabel("New sessions per member").fill("3");
	await page.getByRole("button", { name: "Save pool" }).click();
	await expect(page.getByText("3 new sessions per member")).toBeVisible();
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/provider-pools/provider-pools.png"
		),
		fullPage: true,
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("button", { name: "Edit pool overflow" }).click();
	await expect(page.getByLabel("Pool name")).toBeVisible();
	await expect(page.getByLabel("Cooldown wait (ms)")).toHaveValue("750");
	await expect(
		page.getByRole("switch", { name: "Last resort" }).nth(1)
	).toBeChecked();
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/provider-pools/provider-pools-mobile.png"
		),
		fullPage: true,
	});
	expect(errors).toEqual([]);
});

test("edits bounded fusion with two models on one provider and preserves partial Auto weights", async ({
	page,
}) => {
	test.setTimeout(180_000);
	page.setDefaultTimeout(45_000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(message.text());
		}
	});
	await page.goto("/provider-pools-proof.html", {
		waitUntil: "domcontentloaded",
	});
	try {
		await expect(
			page.getByRole("heading", { name: "Provider pool routing" })
		).toBeVisible({ timeout: 45_000 });
	} catch (error) {
		await test.info().attach("routing-page-errors.json", {
			body: Buffer.from(JSON.stringify(errors, null, 2)),
			contentType: "application/json",
		});
		await test.info().attach("routing-load-failure.png", {
			body: await page.screenshot({ fullPage: true }),
			contentType: "image/png",
		});
		throw error;
	}
	await page.getByRole("button", { name: "Create pool" }).click();
	await expect(
		page.getByText(
			"Lower priority numbers run first. Weights apply to weighted random selection and legacy weighted rotation.",
			{ exact: true }
		)
	).toBeVisible();
	await page.getByLabel("Pool name").fill("ensemble");
	await page.getByLabel("Routing strategy").click();
	await expect(
		page.getByRole("option", { name: "Priority", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("option", { name: "Context optimized", exact: true })
	).toBeVisible();
	await page.getByRole("option", { name: "Fusion", exact: true }).click();
	await page.getByRole("button", { name: "Add provider" }).click();
	await page.getByRole("button", { name: "Add provider" }).click();
	await page.getByLabel("Provider 2", { exact: true }).click();
	await page.getByRole("option", { name: "OpenAI", exact: true }).click();
	await page.getByLabel("Upstream model").first().fill("gpt-4o-mini");
	await page.getByLabel("Upstream model").nth(1).fill("gpt-4o-mini");
	await page.getByRole("button", { name: "Save pool" }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Each exact provider/model target"
	);
	await page.getByLabel("Upstream model").nth(1).fill("gpt-4o");
	await page.getByLabel("Context tokens").first().fill("128000");
	await page.getByLabel("Judge provider").click();
	await page.getByRole("option", { name: "OpenAI", exact: true }).click();
	await page.getByLabel("Judge model").fill("gpt-4o-mini");
	await page.getByLabel("Quorum grace (ms)").fill("5001");
	await page.getByRole("button", { name: "Save pool" }).click();
	await expect(page.getByRole("alert")).toContainText("supported bounds");
	await page.getByLabel("Quorum grace (ms)").fill("250");
	await page.getByRole("button", { name: "Save pool" }).click();
	await page.getByRole("button", { name: "Edit pool ensemble" }).click();
	await expect(page.getByLabel("Context tokens").first()).toHaveValue("128000");
	await expect(page.getByLabel("Context tokens").nth(1)).toHaveValue("");
	await expect(page.getByLabel("Judge model")).toHaveValue("gpt-4o-mini");
	await expect(page.getByLabel("Quorum grace (ms)")).toHaveValue("250");
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/provider-pools/provider-pools-fusion-settings.png"
		),
		fullPage: true,
	});
	await page.getByLabel("Routing strategy").click();
	await page.getByRole("option", { name: "Auto", exact: true }).click();
	await page
		.getByText("Advanced Auto scoring weights", { exact: true })
		.click();
	await expect(page.getByLabel("Health", { exact: true })).toHaveValue(
		"0.1605"
	);
	await page.getByRole("switch", { name: "Customize Auto weights" }).click();
	for (const label of [
		"Quota",
		"Health",
		"Inverse cost",
		"Inverse latency",
		"Task fit",
		"Stability",
		"Tier priority",
		"Tier affinity",
		"Specificity match",
		"Context affinity",
		"Cache affinity",
		"Session availability",
		"Reset-window affinity",
		"Connection density",
		"Reliability",
	]) {
		await page.getByLabel(label, { exact: true }).fill("");
	}
	await page.getByLabel("Quality", { exact: true }).fill("1");
	await page.getByRole("button", { name: "Save pool" }).click();
	await page.getByRole("button", { name: "Edit pool ensemble" }).click();
	await page
		.getByText("Advanced Auto scoring weights", { exact: true })
		.click();
	await expect(page.getByLabel("Quality", { exact: true })).toHaveValue("1");
	await expect(page.getByLabel("Health", { exact: true })).toHaveValue("");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/provider-pools/provider-pools-auto-weights-mobile.png"
		),
		fullPage: true,
	});
	expect(errors).toEqual([]);
});
