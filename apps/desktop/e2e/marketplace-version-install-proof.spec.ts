import { expect, type Page, type Route, test } from "@playwright/test";

const id = "com.example.versioned-plugin";
const beta = "1.5.0-beta.1";
const origin = "http://127.0.0.1:5436";
interface RequestLog {
	body: unknown;
	method: string;
	node: string;
	path: string;
	status: number;
}

async function installFixture(
	page: Page,
	options: { denyFirst?: boolean; hold?: boolean } = {}
) {
	await page.addInitScript(() => {
		localStorage.setItem("ryu_session_token", "version-install-buyer");
		localStorage.setItem("ryu_active_user_id", "version-install-user");
		localStorage.setItem(
			"ryu_accounts",
			JSON.stringify([
				{
					token: "version-install-buyer",
					userId: "version-install-user",
					name: "Version buyer",
					email: "version@example.invalid",
					image: null,
				},
			])
		);
	});
	const requests: RequestLog[] = [];
	const unexpected: string[] = [];
	const installed = new Map<string, string>();
	let attempts = 0;
	let held: Route | undefined;
	const entries = [
		{
			id,
			name: "Versioned Plugin",
			version: "2.0.0",
			source: "marketplace",
			origin: "marketplace",
			kinds: ["tool"],
			tags: [],
			description: "A signed listing with historical releases",
			permission_grants: [],
		},
		{
			id: "com.example.builtin",
			name: "Builtin Plugin",
			version: "2.0.0",
			source: "built-in",
			kinds: ["tool"],
			tags: [],
			description: "Built-in archive refusal",
			permission_grants: [],
		},
		{
			id: "com.example.community",
			name: "Community Plugin",
			version: "2.0.0",
			source: "github-topic",
			origin: "community",
			kinds: ["tool"],
			tags: [],
			description: "Community archive refusal",
			permission_grants: [],
		},
	];
	await page.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (
			!(
				url.pathname.startsWith("/__nodes/") || url.pathname.startsWith("/api/")
			)
		) {
			await route.continue();
			return;
		}
		const match = /^\/__nodes\/(alpha|beta)(\/api\/.*)$/.exec(url.pathname);
		if (!match) {
			unexpected.push(`${request.method()} ${request.url()}`);
			await route.abort("failed");
			return;
		}
		expect(url.origin).toBe(origin);
		const node = match[1];
		const pathname = match[2];
		const method = request.method();
		expect(request.headers().authorization).toBe(`Bearer ${node}-node-token`);
		expect(request.headers()["x-ryu-user-jwt"]).toBe(`${node}-delegation`);
		expect(request.headers()["x-ryu-surface"]).toBe("desktop");
		const body: unknown = request.postData() ? request.postDataJSON() : null;
		const log = {
			node,
			method,
			path: pathname + url.search,
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
		if (method === "GET") {
			expect(body).toBeNull();
			if (pathname === "/api/catalog/sources") {
				expect(url.search).toBe("?kind=plugin");
				await reply({ active: "marketplace", sources: [] });
				return;
			}
			if (pathname === "/api/plugins") {
				expect(url.search).toBe("");
				const version = installed.get(node);
				await reply({
					apps: version
						? [
								{
									id,
									name: "Versioned Plugin",
									version,
									installed_version: version,
									installed: true,
									enabled: false,
									channel: "beta",
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
			if (pathname === "/api/marketplace/packages/installed") {
				expect(url.search).toBe("");
				await reply({ packages: [] });
				return;
			}
			if (pathname === "/api/plugins/catalog/browse") {
				expect([...url.searchParams.entries()]).toEqual([
					["limit", "40"],
					["source", "all"],
				]);
				await reply({ entries, next_cursor: null });
				return;
			}
			if (pathname === "/api/plugins/catalog/detail") {
				const selectedId = url.searchParams.get("id");
				expect(entries.map((entry) => entry.id)).toContain(selectedId);
				expect([...url.searchParams.entries()]).toEqual([
					["id", selectedId],
					["source", "all"],
				]);
				await reply({
					...entries.find((entry) => entry.id === selectedId),
					versions: [
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
					],
				});
				return;
			}
		} else if (
			method === "POST" &&
			pathname === "/api/plugins/catalog/install"
		) {
			expect(url.search).toBe("");
			expect(body).toEqual({ id, version: beta });
			expect(request.headers()["x-ryu-buyer-token"]).toBe(
				"version-install-buyer"
			);
			expect(request.headers()["content-type"]).toContain("application/json");
			attempts++;
			if (options.denyFirst && attempts === 1) {
				log.status = 403;
				await reply({
					error: "grants_denied",
					message: "Historical version install denied",
				});
				return;
			}
			installed.set(node, beta);
			if (options.hold && attempts === 1) {
				held = route;
				return;
			}
			await reply({ installed: true });
			return;
		}
		unexpected.push(`${method} ${url.pathname}${url.search}`);
		await route.abort("failed");
	});
	return {
		requests,
		unexpected,
		installed,
		isHeld: () => Boolean(held),
		release: async () => {
			if (!held) {
				throw new Error("Expected a held exact-version install");
			}
			await held.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ installed: true }),
			});
		},
	};
}

async function openListing(page: Page, name = "Versioned Plugin") {
	await page.getByRole("button", { name, exact: true }).click();
	await expect(
		page.getByRole("button", { name: `Install ${beta}`, exact: true })
	).toBeVisible();
}

async function confirmBeta(page: Page) {
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

test("exact beta install refusal retains selection and retry reads back the installed version", async ({
	page,
}, testInfo) => {
	const fixture = await installFixture(page, { denyFirst: true });
	await page.goto("/marketplace-version-install-proof.html");
	await openListing(page);
	await confirmBeta(page);
	await expect(page.getByRole("alert")).toHaveText(
		"Gateway denied one or more permission grants."
	);
	await expect(
		page.getByRole("region", { name: "Selected listing" }).getByRole("heading")
	).toHaveText("Versioned Plugin");
	await expect(
		page.getByLabel("Installed version", { exact: true })
	).toHaveText("Not installed");
	await expect(
		page.getByRole("button", { name: `Install ${beta}`, exact: true })
	).toBeEnabled();
	await confirmBeta(page);
	await expect(
		page.getByLabel("Installed version", { exact: true })
	).toHaveText(beta);
	await expect(page.getByLabel("Installed state", { exact: true })).toHaveText(
		"true"
	);
	await expect(
		page.getByText(`Installed ${beta}`, { exact: true })
	).toBeVisible();
	await page.reload();
	await openListing(page);
	await expect(
		page.getByLabel("Installed version", { exact: true })
	).toHaveText(beta);
	const writes = fixture.requests.filter(
		(request) => request.method === "POST"
	);
	expect(writes).toEqual([
		{
			node: "alpha",
			method: "POST",
			path: "/api/plugins/catalog/install",
			body: { id, version: beta },
			status: 403,
		},
		{
			node: "alpha",
			method: "POST",
			path: "/api/plugins/catalog/install",
			body: { id, version: beta },
			status: 200,
		},
	]);
	expect(fixture.installed.get("alpha")).toBe(beta);
	expect(fixture.unexpected).toEqual([]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: testInfo.outputPath("marketplace-beta-install-recovered.png"),
	});
});

test("a held Alpha exact-version completion cannot publish installed success on Beta", async ({
	page,
}, testInfo) => {
	const fixture = await installFixture(page, { hold: true });
	await page.goto("/marketplace-version-install-proof.html");
	// Prime Beta's real detail/readback cache before the held Alpha write. A
	// return to a previously visited node must retain the production URL-keyed
	// panel lifetime even when cached detail avoids a cold-loading disappearance.
	await page
		.getByRole("button", { name: "Switch to Beta", exact: true })
		.click();
	await openListing(page);
	await expect(
		page.getByLabel("Installed version", { exact: true })
	).toHaveText("Not installed");
	await page
		.getByRole("button", { name: "Switch to Alpha", exact: true })
		.click();
	await expect(page.getByLabel("Active target", { exact: true })).toHaveText(
		"Alpha"
	);
	await expect
		.poll(
			() =>
				fixture.requests.filter(
					(request) =>
						request.node === "alpha" &&
						request.path.startsWith("/api/plugins/catalog/detail?")
				).length
		)
		.toBeGreaterThan(0);
	await expect(
		page.getByRole("button", { name: `Install ${beta}`, exact: true })
	).toBeVisible();
	await openListing(page);
	await confirmBeta(page);
	await expect.poll(fixture.isHeld).toBe(true);
	await page
		.getByRole("button", { name: "Switch to Beta", exact: true })
		.click();
	await expect(page.getByLabel("Active target", { exact: true })).toHaveText(
		"Beta"
	);
	await expect
		.poll(
			() =>
				fixture.requests.filter(
					(request) =>
						request.node === "beta" && request.path === "/api/plugins"
				).length
		)
		.toBeGreaterThan(0);
	await expect(
		page.getByLabel("Installed version", { exact: true })
	).toHaveText("Not installed");
	await fixture.release();
	await expect(
		page.getByRole("button", { name: `Install ${beta}`, exact: true })
	).toBeEnabled();
	await expect(
		page.getByText(`Installed ${beta}`, { exact: true })
	).toHaveCount(0);
	await expect(page.getByLabel("Installed state", { exact: true })).toHaveText(
		"false"
	);
	await confirmBeta(page);
	await expect(
		page.getByLabel("Installed version", { exact: true })
	).toHaveText(beta);
	expect(
		fixture.requests
			.filter((request) => request.method === "POST")
			.map((request) => request.node)
	).toEqual(["alpha", "beta"]);
	expect(fixture.installed.get("alpha")).toBe(beta);
	expect(fixture.installed.get("beta")).toBe(beta);
	expect(fixture.unexpected).toEqual([]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: testInfo.outputPath("marketplace-beta-target-install-completed.png"),
	});
});

test("exact-version hook refuses built-in and community archives without transport writes", async ({
	page,
}) => {
	const fixture = await installFixture(page);
	await page.goto("/marketplace-version-install-proof.html");
	await openListing(page, "Builtin Plugin");
	await confirmBeta(page);
	await expect(page.getByRole("alert")).toHaveText(
		"Built-in plugins do not have separate version archives."
	);
	await openListing(page, "Community Plugin");
	await confirmBeta(page);
	await expect(page.getByRole("alert")).toHaveText(
		"Community listings are browse-only — open the repository to review it before installing."
	);
	expect(
		fixture.requests.filter((request) => request.method === "POST")
	).toEqual([]);
	expect(fixture.installed.size).toBe(0);
	expect(fixture.unexpected).toEqual([]);
});
