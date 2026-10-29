import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";

const proof = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/parallel/plugins-runtime/full/cards"
);
const rowSchema = z.object({
	entry: z
		.object({
			id: z.string(),
			name: z.string(),
			version: z.string(),
			type: z.string(),
			hidden: z.boolean().optional(),
			mandatory: z.boolean().optional(),
			permission_grants: z.array(z.string()),
		})
		.catchall(z.json()),
	manifest: z
		.object({ id: z.string(), name: z.string(), version: z.string() })
		.catchall(z.json()),
	package: z.string(),
});
const rows = z
	.array(rowSchema)
	.parse(
		JSON.parse(readFileSync(path.join(proof, "core-projection.json"), "utf8"))
	);

if (rows.length !== 87) {
	throw new Error("Run the exact Core catalog projection fixture first");
}
test.describe.configure({ timeout: 120_000 });
const liveCore = process.env.RYU_CARDS_PROOF_CORE_URL;
const liveToken = process.env.RYU_CARDS_PROOF_CORE_TOKEN;
const selectedLivePackages: string[] = process.env.RYU_CARDS_PROOF_PACKAGES
	? JSON.parse(process.env.RYU_CARDS_PROOF_PACKAGES)
	: ["plugins/ego-browser"];
if (
	liveCore &&
	(new URL(liveCore).hostname !== "127.0.0.1" ||
		!liveToken?.startsWith("ryu-fixture-"))
) {
	throw new Error(
		"Live card proof requires an isolated loopback Core and synthetic token"
	);
}
for (const row of liveCore
	? rows.filter((row) => selectedLivePackages.includes(row.package))
	: rows) {
	test(`${row.package} card renders exact Core identity and lifecycle feedback`, async ({
		page,
	}) => {
		mkdirSync(proof, { recursive: true });
		let installed = false;
		if (row.package === "plugins/tavily") {
			await page.route("https://www.tavily.com/favicon.ico", (route) =>
				route.abort()
			);
		}
		let enabled = false;
		let denyEnable = true;
		let denyDisable = true;
		await page.addInitScript(
			(counts) => Object.assign(window, { __ryuShippedCardsCounts: counts }),
			{
				apps: row.entry.type === "app" ? 1 : 0,
				plugins: row.entry.type === "plugin" ? 1 : 0,
			}
		);
		const preferences = new Map<string, string>();
		page.on("pageerror", (error) =>
			writeFileSync(
				path.join(proof, "first-page-error.txt"),
				error.stack ?? error.message
			)
		);
		page.on("console", (message) => {
			if (message.type() === "error") {
				writeFileSync(
					path.join(proof, "first-console-error.txt"),
					message.text()
				);
			}
		});
		const calls: Array<{ method: string; path: string; body: unknown }> = [];
		await page.route("**/api/**", async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (!url.pathname.startsWith("/api/")) {
				return route.continue();
			}
			calls.push({
				method: request.method(),
				path: url.pathname,
				body: request.postData() ? request.postDataJSON() : null,
			});
			if (
				liveCore &&
				(url.pathname === "/api/plugins" ||
					url.pathname.match(
						/^\/api\/plugins\/[^/]+\/(install|enable|disable)$/
					))
			) {
				if (url.pathname.endsWith("/disable") && denyDisable) {
					denyDisable = false;
					return route.fulfill({
						status: 503,
						contentType: "application/json",
						body: JSON.stringify({
							error:
								"Controlled browser transport failure before Core dispatch",
						}),
					});
				}
				const response = await route.fetch({
					url: `${liveCore}${url.pathname}${url.search}`,
					headers: {
						...request.headers(),
						authorization: `Bearer ${liveToken}`,
					},
				});
				const actual = await page.request.get(`${liveCore}/api/plugins`, {
					headers: { authorization: `Bearer ${liveToken}` },
				});
				expect(actual.ok()).toBe(true);
				const state = z
					.object({
						apps: z.array(
							z.object({
								id: z.string(),
								installed: z.boolean(),
								enabled: z.boolean(),
							})
						),
					})
					.parse(await actual.json());
				const record = state.apps.find((item) => item.id === row.entry.id);
				installed = record?.installed ?? false;
				enabled = record?.enabled ?? false;
				writeFileSync(
					path.join(proof, "live-core-state.json"),
					`${JSON.stringify(state, null, 2)}\n`
				);
				return route.fulfill({ response });
			}
			const json = <FixturePayload>(value: FixturePayload, status = 200) =>
				route.fulfill({
					status,
					contentType: "application/json",
					body: JSON.stringify(value),
				});
			if (
				url.pathname === "/api/plugins/catalog/browse" ||
				url.pathname === "/api/plugins/catalog"
			) {
				return json({
					entries:
						url.searchParams.get("origin") === "community" ? [] : [row.entry],
					next_cursor: null,
				});
			}
			if (url.pathname.startsWith("/api/preferences/")) {
				const key = decodeURIComponent(
					url.pathname.slice("/api/preferences/".length)
				);
				if (request.method() === "PUT") {
					preferences.set(key, String(request.postDataJSON().value));
				}
				return json({ key, value: preferences.get(key) ?? null });
			}
			if (url.pathname === "/api/plugins") {
				return json({
					apps: installed
						? [
								{
									...row.manifest,
									version: row.entry.version,
									installed: true,
									installed_version: row.entry.version,
									enabled,
									approved_grants: enabled ? row.entry.permission_grants : [],
									permission_grants: row.entry.permission_grants,
								},
							]
						: [],
				});
			}
			if (url.pathname === "/api/plugins/catalog/detail") {
				expect(url.searchParams.get("id")).toBe(row.entry.id);
				return json({
					id: row.entry.id,
					name: row.entry.name,
					description: row.entry.description,
					version: row.entry.version,
					source: "built-in",
					origin: "first_party",
					reviewed: true,
					permissions: { declared: true },
					permissionGrants: row.entry.permission_grants,
					surfaces: row.entry.surfaces,
					readme: `# ${row.entry.name}\n\n${row.entry.description}`,
					versions: [
						{
							version: row.entry.version,
							stability: "stable",
							installable: true,
						},
					],
				});
			}
			if (url.pathname === "/api/plugins/catalog/channels") {
				return json({
					channels: [
						{
							channel: "stable",
							version: row.entry.version,
							installable: true,
						},
					],
				});
			}
			if (
				url.pathname ===
				`/api/plugins/${encodeURIComponent(row.entry.id)}/enable`
			) {
				if (denyEnable) {
					denyEnable = false;
					return json({ error: "Controlled enable refusal" }, 403);
				}
				enabled = true;
				return json({
					app: {
						id: row.entry.id,
						version: row.entry.version,
						enabled,
						approved_grants: row.entry.permission_grants,
						created_at: "2026-10-04T00:00:00Z",
						updated_at: "2026-10-04T00:00:00Z",
					},
				});
			}
			if (
				url.pathname ===
				`/api/plugins/${encodeURIComponent(row.entry.id)}/disable`
			) {
				if (denyDisable) {
					denyDisable = false;
					return json({ error: "Controlled disable failure" }, 503);
				}
				enabled = false;
				return json({
					app: {
						id: row.entry.id,
						version: row.entry.version,
						enabled,
						approved_grants: [],
						created_at: "2026-10-04T00:00:00Z",
						updated_at: "2026-10-04T00:00:00Z",
					},
				});
			}
			if (url.pathname === "/api/catalog/sources") {
				return json({
					active: "ryu-catalog",
					sources: [
						{
							id: "ryu-catalog",
							display_name: "Ryu Marketplace",
							builtin: true,
							base_url: null,
						},
					],
				});
			}
			if (
				url.pathname ===
				`/api/plugins/${encodeURIComponent(row.entry.id)}/install`
			) {
				installed = true;
				return json({
					app: {
						id: row.entry.id,
						version: row.entry.version,
						enabled: false,
						approved_grants: [],
						created_at: "2026-10-04T00:00:00Z",
						updated_at: "2026-10-04T00:00:00Z",
					},
				});
			}
			if (url.pathname === "/api/plugins/lifecycle-capabilities") {
				return json({
					install: true,
					enable: true,
					disable: true,
					uninstall: true,
				});
			}
			return json({
				entries: [],
				items: [],
				apps: [],
				models: [],
				skills: [],
				agents: [],
				sources: [],
				next_cursor: null,
				preferences: {},
			});
		});
		await page.goto(
			`/marketplace-store-home.html?section=${row.entry.type === "app" ? "apps" : "plugins"}`
		);
		await page
			.getByRole("button", { name: /^(Filters|Source & install)$/ })
			.click();
		await page
			.getByRole("checkbox", { name: "Show unstable releases" })
			.check();
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "Grid view", exact: true }).click();
		const title = page.getByText(row.entry.name, { exact: true }).first();
		await expect(title).toBeVisible();
		if (row.package === "plugins/ego-browser") {
			const geometry = await title.evaluate((element) => {
				const range = document.createRange();
				range.selectNodeContents(element);
				const text = range.getBoundingClientRect();
				const box = element.getBoundingClientRect();
				return {
					textWidth: text.width,
					boxWidth: box.width,
					fits: text.width <= box.width + 1,
				};
			});
			expect(geometry.fits).toBe(true);
			writeFileSync(
				path.join(proof, "ego-name-geometry.json"),
				`${JSON.stringify(geometry, null, 2)}\n`
			);
		}
		if (row.entry.mandatory) {
			await expect(
				page.getByText("Required", { exact: true }).first()
			).toBeVisible();
		} else {
			await page
				.getByRole("button", { name: /^(Get|Add)$/, exact: true })
				.first()
				.click();
			await expect.poll(() => installed).toBe(true);
			expect(
				calls.some(
					(call) =>
						call.path ===
							`/api/plugins/${encodeURIComponent(row.entry.id)}/install` &&
						call.method === "POST"
				)
			).toBe(true);
			await page.reload();
			await expect(
				page.getByText(row.entry.name, { exact: true }).first()
			).toBeVisible();
		}
		if (!row.entry.mandatory) {
			await page
				.getByRole("button", { name: row.entry.name, exact: true })
				.first()
				.click();
			const detail = page.getByRole("dialog").first();
			await expect(detail).toContainText(row.entry.name);
			await expect(detail).toContainText(row.entry.version);
			const enableAttempts =
				liveCore && row.entry.permission_grants.length === 0 ? 1 : 2;
			for (let attempt = 0; attempt < enableAttempts; attempt += 1) {
				await detail
					.getByRole("button", { name: "Enable", exact: true })
					.click();
				const consent = page.getByRole("alertdialog");
				await expect(consent).toContainText(`Enable ${row.entry.name}?`);
				await consent
					.getByRole("button", { name: "Allow", exact: true })
					.click();
				if (attempt === 0 && enableAttempts === 2) {
					await expect(
						page
							.getByText(
								liveCore
									? "Gateway denied grants:"
									: "Gateway denied one or more permission grants.",
								{
									exact: false,
								}
							)
							.last()
					).toBeVisible();
					expect(enabled).toBe(false);
				} else {
					await expect.poll(() => enabled).toBe(true);
				}
			}
			await expect(
				detail.getByRole("button", { name: "Disable", exact: true })
			).toBeVisible();
			await detail
				.getByRole("button", { name: "Disable", exact: true })
				.click();
			await expect(
				page
					.getByText("Gateway unreachable (fail-closed): gateway unreachable", {
						exact: false,
					})
					.last()
			).toBeVisible();
			expect(enabled).toBe(true);
			await detail
				.getByRole("button", { name: "Disable", exact: true })
				.click();
			await expect.poll(() => enabled).toBe(false);
			await page.reload();
			await page
				.getByRole("button", { name: row.entry.name, exact: true })
				.first()
				.click();
			await expect(
				page
					.getByRole("dialog")
					.first()
					.getByRole("button", { name: "Enable", exact: true })
			).toBeVisible();
		}
		writeFileSync(
			path.join(proof, `${row.package.replaceAll("/", "-")}-requests.json`),
			`${JSON.stringify(calls, null, 2)}\n`
		);
		if (row.package === "plugins/tavily") {
			await expect
				.poll(async () =>
					page
						.locator("img:visible")
						.evaluateAll((images) =>
							images.every(
								(image) =>
									!(image instanceof HTMLImageElement) ||
									(image.complete && image.naturalWidth > 0)
							)
						)
				)
				.toBe(true);
		}
		if (liveCore) {
			await page.screenshot({
				path: path.join(
					proof,
					`live-${row.package.replaceAll("/", "-")}-completed.png`
				),
				animations: "disabled",
			});
		}
		if (row.package === "plugins/ego-browser") {
			await page.screenshot({
				path: path.join(proof, "ego-browser-card-completed.png"),
				animations: "disabled",
			});
		}
	});
}
