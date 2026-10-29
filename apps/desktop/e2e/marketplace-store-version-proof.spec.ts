import { expect, type Page, test } from "@playwright/test";

const origin = "http://127.0.0.1:58199";
const id = "com.example.versioned-plugin";
const beta = "1.5.0-beta.1";
interface RequestRecord {
	body: unknown;
	installedVersion?: string | null;
	method: string;
	path: string;
	status: number;
}

async function installProductFixture(page: Page) {
	await page.addInitScript(() => {
		localStorage.setItem("ryu:interface-level", "expert");
		localStorage.setItem("ryu_session_token", "store-version-buyer");
		localStorage.setItem("ryu_active_user_id", "store-version-user");
		localStorage.setItem(
			"ryu_accounts",
			JSON.stringify([
				{
					token: "store-version-buyer",
					userId: "store-version-user",
					name: "Marketplace buyer",
					email: "store@example.invalid",
					image: null,
				},
			])
		);
	});
	const requests: RequestRecord[] = [];
	const unknown: string[] = [];
	let installedVersion: string | null = null;
	let writes = 0;
	const versions = [
		{
			version: "2.0.0",
			installable: true,
			stability: "stable",
			stabilityKnown: true,
		},
		{
			version: beta,
			installable: true,
			prerelease: true,
			stability: "beta",
			stabilityKnown: true,
		},
	];
	const entry = {
		id,
		name: "Versioned Plugin",
		version: "2.0.0",
		source: "marketplace",
		kinds: ["tool"],
		tags: ["productivity"],
		description:
			"Read workspace notes and organize them into a concise report.",
		permission_grants: [],
		first_party: true,
	};
	await page.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (!url.pathname.startsWith("/api/")) {
			await route.continue();
			return;
		}
		expect(url.origin).toBe(origin);
		const method = request.method();
		const body: unknown = request.postData() ? request.postDataJSON() : null;
		const log: RequestRecord = {
			method,
			path: url.pathname + url.search,
			body,
			status: 200,
		};
		requests.push(log);
		const reply = <FixturePayload>(payload: FixturePayload) =>
			route.fulfill({
				status: log.status,
				contentType: "application/json",
				body: JSON.stringify(payload),
			});
		if (
			method === "GET" &&
			url.pathname === "/api/billing/subscription-status"
		) {
			expect(url.search).toBe("");
			expect(body).toBeNull();
			expect(request.headers().authorization).toBe(
				"Bearer store-version-buyer"
			);
			await reply({
				entitlement: { marketplaceApps: false },
				features: null,
				lifetime: null,
			});
			return;
		}
		if (method === "POST" && url.pathname === "/api/billing/trial") {
			expect(url.search).toBe("");
			expect(body).toBeNull();
			expect(request.headers().authorization).toBe(
				"Bearer store-version-buyer"
			);
			await reply({ firstLaunchAt: new Date().toISOString() });
			return;
		}
		expect(request.headers().authorization).toBe(
			"Bearer store-version-node-token"
		);
		expect(request.headers()["x-ryu-user-jwt"]).toBe(
			"store-version-delegation"
		);
		expect(request.headers()["x-ryu-surface"]).toBe("desktop");
		if (
			method === "PUT" &&
			(url.pathname === "/api/preferences/entitlement-active" ||
				url.pathname === "/api/preferences/managed-inference-entitled")
		) {
			expect(url.search).toBe("");
			expect(body).toEqual({
				value: url.pathname.endsWith("/entitlement-active") ? "true" : "false",
			});
			await reply({});
			return;
		}
		if (method === "GET") {
			expect(body).toBeNull();
			if (url.pathname === "/api/plugins/contributions") {
				expect(url.search).toBe("");
				await reply({
					companions: [],
					settings_tabs: [],
					store_tabs: [],
					views: [],
				});
				return;
			}
			if (url.pathname === "/api/plugins") {
				expect(url.search).toBe("");
				log.installedVersion = installedVersion;
				await reply({
					apps: installedVersion
						? [
								{
									id,
									name: entry.name,
									version: installedVersion,
									installed_version: installedVersion,
									installed: true,
									enabled: false,
									channel: null,
									permission_grants: [],
									approved_grants: [],
									runnables: [],
									built_in: false,
									local_only: false,
								},
							]
						: [],
				});
				return;
			}
			if (url.pathname === "/api/marketplace/packages/installed") {
				expect(url.search).toBe("");
				await reply({ packages: [] });
				return;
			}
			if (url.pathname === "/api/catalog/sources") {
				expect(url.search).toBe("?kind=plugin");
				await reply({ active: "marketplace", sources: [] });
				return;
			}
			if (url.pathname === "/api/plugins/catalog/browse") {
				if (url.searchParams.has("origin")) {
					expect([...url.searchParams.entries()]).toEqual([
						["limit", "40"],
						["origin", "community"],
					]);
					await reply({ entries: [], next_cursor: null });
				} else {
					expect([...url.searchParams.entries()]).toEqual([
						["limit", "40"],
						["source", "all"],
					]);
					await reply({ entries: [entry], next_cursor: null });
				}
				return;
			}
			if (url.pathname === "/api/plugins/catalog/detail") {
				expect([...url.searchParams.entries()]).toEqual([
					["id", id],
					["source", "all"],
				]);
				await reply({
					...entry,
					readme:
						"# Versioned Plugin\n\nTurn workspace notes into a report. Choose a published version to install.",
					versions,
				});
				return;
			}
			if (url.pathname === "/api/plugins/catalog/channels") {
				expect([...url.searchParams.entries()]).toEqual([["id", id]]);
				await reply({
					channels: [
						{ channel: "stable", installable: true, version: "2.0.0" },
						{ channel: "beta", installable: true, version: beta },
					],
				});
				return;
			}
		} else if (
			method === "POST" &&
			url.pathname === "/api/plugins/catalog/install"
		) {
			expect(url.search).toBe("");
			expect(body).toEqual({ id, version: beta });
			expect(versions.filter((version) => version.version === beta)).toEqual([
				{
					version: beta,
					installable: true,
					prerelease: true,
					stability: "beta",
					stabilityKnown: true,
				},
			]);
			expect(request.headers()["x-ryu-buyer-token"]).toBe(
				"store-version-buyer"
			);
			expect(request.headers()["content-type"]).toContain("application/json");
			writes++;
			if (writes === 1) {
				log.status = 403;
				await reply({
					error: "grants_denied",
					denied_grants: ["plugin:install"],
					message: "Historical install refused",
				});
			} else {
				expect(writes).toBe(2);
				installedVersion = beta;
				await reply({ installed: true });
			}
			return;
		}
		unknown.push(`${method} ${url.pathname}${url.search}`);
		await route.abort("failed");
	});
	return { requests, unknown, readInstalledVersion: () => installedVersion };
}

async function confirmHistoricalVersion(page: Page) {
	await page
		.getByRole("button", { name: `Install ${beta}`, exact: true })
		.click();
	const dialog = page.getByRole("alertdialog");
	await expect(
		dialog.getByRole("heading", { name: `Install ${beta}?`, exact: true })
	).toBeVisible();
	await dialog
		.getByRole("button", { name: "Install version", exact: true })
		.click();
}

test("actual Desktop Plugins detail completes exact beta install after refusal and reads persisted state", async ({
	page,
}, testInfo) => {
	const diagnostics: string[] = [];
	page.on("pageerror", (error) =>
		diagnostics.push(`pageerror: ${error.stack ?? error.message}`)
	);
	page.on("requestfailed", (request) =>
		diagnostics.push(
			`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown failure"}`
		)
	);
	page.on("response", (response) => {
		if (response.status() >= 400) {
			diagnostics.push(`HTTP ${response.status()}: ${response.url()}`);
		}
	});
	try {
		const fixture = await installProductFixture(page);
		const installedReads = () =>
			fixture.requests.filter(
				(request) =>
					request.path === "/api/plugins" && request.installedVersion === beta
			).length;
		await page.goto("/marketplace-store-version-proof.html");
		await page.getByRole("tab", { name: "Versions", exact: true }).click();
		await expect(
			page.getByRole("tabpanel").getByText("Beta", { exact: true })
		).toBeVisible();
		await confirmHistoricalVersion(page);
		await expect(
			page
				.getByText("Gateway denied grants: plugin:install", { exact: true })
				.first()
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: `Install ${beta}`, exact: true })
		).toBeEnabled();
		await expect(
			page.getByRole("tab", { name: "Versions", exact: true })
		).toHaveAttribute("aria-selected", "true");
		expect(fixture.readInstalledVersion()).toBeNull();
		await confirmHistoricalVersion(page);
		await expect(
			page.getByText(`Installed ${beta}`, { exact: true })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Enable", exact: true }).last()
		).toBeVisible();
		await expect(
			page.getByText("Gateway denied grants: plugin:install", { exact: true })
		).toHaveCount(0);
		await expect.poll(installedReads).toBeGreaterThan(0);
		expect(
			fixture.requests.filter(
				(request) => request.path === "/api/plugins/catalog/install"
			)
		).toEqual([
			{
				method: "POST",
				path: "/api/plugins/catalog/install",
				body: { id, version: beta },
				status: 403,
			},
			{
				method: "POST",
				path: "/api/plugins/catalog/install",
				body: { id, version: beta },
				status: 200,
			},
		]);
		expect(fixture.unknown).toEqual([]);
		await page
			.getByText(`Installed ${beta}`, { exact: true })
			.scrollIntoViewIfNeeded();
		await page.screenshot({
			animations: "disabled",
			fullPage: true,
			path: testInfo.outputPath("desktop-store-beta-install-completed.png"),
		});
		const readsBeforeReload = installedReads();
		await page.reload();
		await page.getByRole("tab", { name: "Versions", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Enable", exact: true }).last()
		).toBeVisible();
		await expect.poll(installedReads).toBeGreaterThan(readsBeforeReload);
		expect(fixture.readInstalledVersion()).toBe(beta);
		expect(
			fixture.requests.filter(
				(request) => request.path === "/api/plugins/catalog/install"
			)
		).toHaveLength(2);
		expect(fixture.unknown).toEqual([]);
		await page.screenshot({
			animations: "disabled",
			fullPage: true,
			path: testInfo.outputPath("desktop-store-beta-installed-reload.png"),
		});
	} finally {
		await testInfo.attach("product-runtime-diagnostics", {
			body: JSON.stringify(diagnostics, null, 2),
			contentType: "application/json",
		});
	}
});
