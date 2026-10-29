import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	type PluginDocument,
	pluginDocumentSchema,
} from "../src/lib/api/plugin-wire-values.ts";

test("provider source permissions, targeted replacement and endpoint context", async ({
	page,
}) => {
	const errors: string[] = [];
	const requests: PluginDocument[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/api/gateway/providers", async (route) => {
		requests.push(pluginDocumentSchema.parse(route.request().postDataJSON()));
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				success: true,
				persisted: true,
				configRevision: "a".repeat(64),
				gateway_restarted: false,
				gateway_application: {
					status: "applied",
					requestedRevision: "a".repeat(64),
					appliedRevision: "a".repeat(64),
					epoch: { boot: "00000000-0000-4000-8000-000000000001", sequence: 1 },
				},
			}),
		});
	});
	await page.goto("/sdk-accounts-proof.html");
	await expect(
		page.getByRole("heading", { name: "Additional provider connections" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Remove Groq Environment" })
	).toBeDisabled();
	await expect(
		page.getByLabel("Groq Environment replacement credential")
	).toHaveCount(0);
	await page
		.getByLabel("Groq Personal replacement credential")
		.fill("synthetic-replacement");
	await page
		.getByRole("button", { name: "Replace credential", exact: true })
		.click();
	await expect.poll(() => requests.length).toBe(1);
	expect(requests[0]).toMatchObject({
		provider: "genai-groq",
		account_action: "replace",
		accountId: "a".repeat(64),
		api_key: "synthetic-replacement",
	});
	await expect(
		page.getByLabel("Groq Personal replacement credential")
	).toHaveValue("");
	await page.getByLabel("Vertex AI project").fill("example-project");
	await page.getByLabel("Vertex AI location").fill("us-central1");
	await page
		.getByRole("button", { name: "Save connection", exact: true })
		.first()
		.click();
	await expect.poll(() => requests.length).toBe(2);
	expect(requests[1]).toMatchObject({
		provider: "genai-vertex",
		sdkContext: {
			kind: "vertex",
			project: "example-project",
			location: "us-central1",
		},
	});
	await expect(page.getByLabel("Ollama API key")).toHaveCount(0);
	await expect(
		page.getByText("This endpoint does not use a provider key.", {
			exact: false,
		})
	).toBeVisible();
	const logos = page.locator("img");
	await expect
		.poll(() =>
			logos.evaluateAll(
				(images) =>
					images.filter(
						(image) =>
							image instanceof HTMLImageElement && image.naturalWidth === 0
					).length
			)
		)
		.toBe(0);
	expect(errors).toEqual([]);
	await page.getByLabel("Vertex AI project").fill("");
	await page.getByLabel("Vertex AI location").fill("global");
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/sdk-accounts/desktop.png"
		),
		fullPage: true,
	});
});

test("saved credentials without live application keep the draft and explain the next action", async ({
	page,
}) => {
	await page.route("**/api/gateway/providers", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				success: true,
				persisted: true,
				gateway_restarted: false,
				gateway_application: {
					status: "unmanaged",
					requestedRevision: "a".repeat(64),
				},
			}),
		})
	);
	await page.goto("/sdk-accounts-proof.html");
	await page
		.getByLabel("Groq Personal replacement credential")
		.fill("synthetic-replacement");
	await page
		.getByRole("button", { name: "Replace credential", exact: true })
		.click();
	await expect(page.getByRole("alert")).toHaveText(
		"Connection saved. Restart your externally managed Gateway to apply it."
	);
	await expect(
		page.getByLabel("Groq Personal replacement credential")
	).toHaveValue("synthetic-replacement");
});

test("a mismatched live application receipt preserves the credential draft", async ({
	page,
}) => {
	await page.route("**/api/gateway/providers", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				success: true,
				persisted: true,
				configRevision: "a".repeat(64),
				gateway_restarted: false,
				gateway_application: {
					status: "applied",
					requestedRevision: "a".repeat(64),
					appliedRevision: "b".repeat(64),
					epoch: { boot: "00000000-0000-4000-8000-000000000001", sequence: 1 },
				},
			}),
		})
	);
	await page.goto("/sdk-accounts-proof.html");
	await page
		.getByLabel("Groq Personal replacement credential")
		.fill("synthetic-replacement");
	await page
		.getByRole("button", { name: "Replace credential", exact: true })
		.click();
	await expect(page.getByRole("alert")).toHaveText(
		"Connection saved, but Gateway acknowledged a different configuration. Refresh the node before editing again."
	);
	await expect(
		page.getByLabel("Groq Personal replacement credential")
	).toHaveValue("synthetic-replacement");
});
