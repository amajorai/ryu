import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import type { GatewayEgressConfig } from "../src/lib/api/gateway.ts";
import { pluginDocumentSchema } from "../src/lib/api/plugin-wire-values.ts";

const endpointFieldsSchema = z.object({
	id: z.string(),
	url: z.string(),
	enabled: z.boolean(),
	priority: z.number().optional(),
	username_env: z.string().nullable(),
	password_env: z.string().nullable(),
});
const poolFieldsSchema = z.object({
	include_direct: z.boolean(),
	direct_fallback_only: z.boolean().optional(),
	endpoints: z.array(endpointFieldsSchema),
});
const egressFieldsSchema = z.object({
	assignments: z.record(z.string(), z.string()),
	pools: z.record(z.string(), poolFieldsSchema),
}) satisfies z.ZodType<GatewayEgressConfig>;
const egressProofSchema = z.custom<GatewayEgressConfig>(
	(value) =>
		pluginDocumentSchema.safeParse(value).success &&
		egressFieldsSchema.safeParse(value).success
);
const egressPatchProofSchema = z.object({
	egress: egressProofSchema.nullish(),
});

test.describe.configure({ timeout: 90_000 });

test("creates and assigns an outbound proxy pool", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	let egress: GatewayEgressConfig = {
		assignments: {},
		pools: {},
	};
	await page.route("**/api/gateway/config", async (route) => {
		if (route.request().method() === "PUT") {
			const patch = egressPatchProofSchema.parse(
				route.request().postDataJSON()
			);
			if (patch.egress) {
				egress = patch.egress;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ok: true }),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ egress }),
		});
	});
	await page.route("**/api/gateway/restart", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ success: true }),
		});
	});
	await page.goto("/egress-pools-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await page.getByRole("button", { name: "Create pool" }).click();
	await page.getByLabel("Pool name").fill("private");
	await page.getByRole("button", { name: "Add proxy" }).click();
	await page.getByLabel("Proxy URL").fill("http://127.0.0.1:8080");
	await page.getByLabel("Endpoint ID").fill("proxy-a");
	await page.getByLabel("Priority (lower first)").fill("10");
	await page
		.getByRole("switch", { name: "Include direct connection", exact: true })
		.click();
	await page
		.getByRole("switch", { name: "Use direct only as fallback", exact: true })
		.click();
	await page.getByLabel("Username environment variable").fill("RYU_PROXY_USER");
	await page
		.getByLabel("Password environment variable")
		.fill("RYU_PROXY_PASSWORD");
	await page.getByRole("button", { name: "Save pool" }).click();
	await expect(page.getByText("Saved and restarted Gateway.")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Edit proxy pool private" })
	).toBeVisible();
	await page.getByRole("combobox", { name: "Provider" }).selectOption("openai");
	await page.getByRole("combobox", { name: "Pool" }).selectOption("private");
	await page.getByRole("button", { name: "Assign", exact: true }).click();
	await expect(page.getByText("openai → private")).toBeVisible();
	await page
		.getByRole("combobox", { name: "Provider" })
		.selectOption("assemblyai");
	await page.getByRole("button", { name: "Assign", exact: true }).click();
	await expect(page.getByText("assemblyai → private")).toBeVisible();
	await page
		.getByRole("combobox", { name: "Provider" })
		.selectOption("inworld");
	await page.getByRole("button", { name: "Assign", exact: true }).click();
	await expect(page.getByText("inworld → private")).toBeVisible();
	await page
		.getByRole("combobox", { name: "Provider" })
		.selectOption("replicate");
	await page.getByRole("button", { name: "Assign", exact: true }).click();
	await expect(page.getByText("replicate → private")).toBeVisible();
	await page.getByRole("combobox", { name: "Provider" }).selectOption("fal");
	await page.getByRole("button", { name: "Assign", exact: true }).click();
	await expect(page.getByText("fal → private")).toBeVisible();
	await page.getByRole("combobox", { name: "Provider" }).selectOption("genai");
	await page.getByRole("button", { name: "Assign", exact: true }).click();
	await expect(page.getByText("genai → private")).toBeVisible();
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/egress-pools/egress-pools.png"
		),
		fullPage: true,
	});
	await page.getByRole("button", { name: "Edit proxy pool private" }).click();
	await expect(page.getByLabel("Proxy URL")).toHaveValue(
		"http://127.0.0.1:8080"
	);
	await expect(page.getByLabel("Priority (lower first)")).toHaveValue("10");
	await expect(
		page.getByRole("switch", { name: "Use direct only as fallback" })
	).toBeChecked();
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/egress-pools/egress-pools-editor.png"
		),
		fullPage: true,
	});
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.getByText("openai → private")).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("button", { name: "Edit proxy pool private" }).click();
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/egress-pools/egress-pools-mobile.png"
		),
		fullPage: true,
	});
	expect(egress.assignments.openai).toBe("private");
	expect(egress.assignments.assemblyai).toBe("private");
	expect(egress.assignments.inworld).toBe("private");
	expect(egress.assignments.replicate).toBe("private");
	expect(egress.assignments.fal).toBe("private");
	expect(egress.assignments.genai).toBe("private");
	expect(errors).toEqual([]);
});
