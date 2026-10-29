import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const STORY_URL = "/mesh-auto-install-proof.html";

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
function proofPath(relative: string): string {
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	return override
		? path.join(override, path.basename(relative))
		: path.resolve(import.meta.dirname, "../../../docs/proof", relative);
}

test.describe.configure({ timeout: 120_000 });

test("shows the Tailcat no-setup default and managed install copy", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));

	await page.goto(STORY_URL);
	await expect(page.locator("body")).toHaveAttribute(
		"data-harness-ready",
		"true"
	);

	const networkHeading = page.getByRole("heading", {
		name: "Network and Tunnel",
	});
	await expect(networkHeading).toBeVisible();
	await expect(
		page.getByText(
			"Connect privately with Tailscale, Headscale, or Tailcat, or create a temporary public Cloudflare Quick Tunnel.",
			{ exact: false }
		)
	).toBeVisible();
	await expect(page.getByText("Enable tunnel")).toBeVisible();
	await expect(
		page.getByText(
			"Ryu installs Tailcat automatically. Tailcat has no account, control server, or tailnet; it creates a short-lived address for this node.",
			{ exact: true }
		)
	).toBeVisible();
	await expect(page.getByRole("switch").first()).not.toBeChecked();

	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("mesh-auto-install-proof.png"),
	});

	expect(browserErrors, `browser errors: ${browserErrors.join(" | ")}`).toEqual(
		[]
	);
});

test("copies only the public Cloudflare Quick Tunnel URL into the browser clipboard and shows its sharing warning", async ({
	page,
	context,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	await page.goto(`${STORY_URL}?cloudflared`);
	await expect(page.locator("body")).toHaveAttribute(
		"data-harness-ready",
		"true"
	);

	await expect(
		page.getByRole("heading", { name: "Network and Tunnel" })
	).toBeVisible();
	await expect(page.getByLabel("Cloudflare Quick Tunnel URL")).toHaveValue(
		"https://warm-tree.trycloudflare.com"
	);
	await expect(page.getByLabel("Tailcat address")).toHaveCount(0);
	await page.evaluate(() =>
		navigator.clipboard.writeText("tailcat://unrelated-private-address")
	);
	await page.getByRole("button", { name: "Copy URL", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe("https://warm-tree.trycloudflare.com");
	await expect(
		page.getByRole("button", { name: "Copied", exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Cloudflare URL copied", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText(/This public URL changes when the tunnel restarts/)
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: proofPath("cloudflare-quick-tunnel-proof.png"),
	});

	expect(browserErrors, `browser errors: ${browserErrors.join(" | ")}`).toEqual(
		[]
	);
});

// Exercise Chromium's real permission boundary rather than replacing Clipboard.
async function denyBrowserClipboardWrites(page: Page): Promise<void> {
	const session = await page.context().newCDPSession(page);
	try {
		const { targetInfo } = await session.send("Target.getTargetInfo");
		expect(targetInfo.browserContextId).toBeTruthy();
		for (const allowWithoutSanitization of [false, true]) {
			await session.send("Browser.setPermission", {
				browserContextId: targetInfo.browserContextId,
				origin: new URL(page.url()).origin,
				permission: { name: "clipboard-write", allowWithoutSanitization },
				setting: "denied",
			});
		}
		await expect
			.poll(() =>
				page.evaluate(
					async () =>
						(
							await navigator.permissions.query({
								name: "clipboard-write" as PermissionName,
							})
						).state
				)
			)
			.toBe("denied");
	} finally {
		await session.detach();
	}
}

for (const backend of ["cloudflared", "tailcat"] as const) {
	test(`${backend} browser clipboard permission refusal preserves clipboard and never reports Copied; explicit retry copies only its address`, async ({
		page,
		context,
	}) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await page.goto(
			backend === "cloudflared" ? `${STORY_URL}?cloudflared` : STORY_URL
		);
		const address =
			backend === "cloudflared"
				? "https://warm-tree.trycloudflare.com"
				: "tailcat://node-proof-secret";
		const label =
			backend === "cloudflared"
				? "Cloudflare Quick Tunnel URL"
				: "Tailcat address";
		if (backend === "tailcat") {
			await page.getByRole("switch").first().click();
		}
		await expect(page.getByLabel(label)).toHaveValue(address);
		const sentinel = `browser-clipboard-before-${backend}-refusal`;
		await page.evaluate(
			(value) => navigator.clipboard.writeText(value),
			sentinel
		);
		await denyBrowserClipboardWrites(page);
		const copy = page.getByRole("button", {
			name: backend === "cloudflared" ? "Copy URL" : "Copy",
			exact: true,
		});
		await copy.click();
		await expect(
			page.getByText(
				backend === "cloudflared"
					? "Could not copy the Cloudflare URL"
					: "Could not copy the Tailcat address",
				{ exact: true }
			)
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Copied", exact: true })
		).toHaveCount(0);
		await expect(
			page.getByText(
				backend === "cloudflared"
					? "Cloudflare URL copied"
					: "Tailcat address copied",
				{ exact: true }
			)
		).toHaveCount(0);
		await expect(page.getByLabel(label)).toHaveValue(address);
		expect(
			await page.evaluate(() =>
				window.__meshProof.requests.filter(
					(request) => request.method !== "GET"
				)
			)
		).toEqual(
			backend === "cloudflared"
				? []
				: [
						{
							body: { enabled: true },
							method: "POST",
							path: "/api/mesh/config",
						},
					]
		);
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
			sentinel
		);
		await copy.click();
		await expect
			.poll(() => page.evaluate(() => navigator.clipboard.readText()))
			.toBe(address);
		await expect(
			page.getByRole("button", { name: "Copied", exact: true })
		).toBeVisible();
		await expect(
			page.getByText(
				backend === "cloudflared"
					? "Cloudflare URL copied"
					: "Tailcat address copied",
				{ exact: true }
			)
		).toBeVisible();
	});
}

test("enables, persists, copies, and disables the private network", async ({
	page,
	context,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.goto(STORY_URL);
	const toggle = page.getByRole("switch").first();
	await expect(toggle).not.toBeChecked();
	await toggle.click();
	await expect(toggle).toBeChecked();
	await expect(
		page.getByRole("textbox", { name: "Tailcat address" })
	).toHaveValue("tailcat://node-proof-secret");
	await page.screenshot({
		fullPage: true,
		path: proofPath(
			"test-coverage-sweep-20260924/evidence/gateway-network-enabled.png"
		),
	});

	await page.reload();
	const persistedToggle = page.getByRole("switch").first();
	await expect(persistedToggle).toBeChecked();
	await expect(
		page.getByRole("textbox", { name: "Tailcat address" })
	).toHaveValue("tailcat://node-proof-secret");
	await expect(page.getByLabel("Cloudflare Quick Tunnel URL")).toHaveCount(0);
	await page.evaluate(() =>
		navigator.clipboard.writeText("https://unrelated-public.trycloudflare.com")
	);
	await page.getByRole("button", { name: "Copy", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe("tailcat://node-proof-secret");
	await persistedToggle.click();
	await expect(persistedToggle).not.toBeChecked();
	await expect(
		page.getByRole("textbox", { name: "Tailcat address" })
	).toHaveCount(0);
});

test("keeps the private network off and reports a failed enable", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await page.evaluate(() => {
		window.__meshProof.failNextWrite = true;
	});
	const toggle = page.getByRole("switch").first();
	await toggle.click();
	await expect(toggle).not.toBeChecked();
	await expect(toggle).toBeEnabled();
	// The control is labelled "Enable tunnel" (Tailscale, Headscale, Tailcat or
	// Cloudflare), so the refusal names the tunnel, not the older "mesh" copy.
	await expect(page.getByText("Failed to enable the tunnel")).toBeVisible();
	const refused = await page.evaluate(() => ({
		enabled: window.__meshProof.enabled,
		writes: window.__meshProof.requests.filter(
			(request) => request.path === "/api/mesh/config"
		),
	}));
	expect(refused.enabled).toBe(false);
	expect(refused.writes).toEqual([
		{ body: { enabled: true }, method: "POST", path: "/api/mesh/config" },
	]);
	await page.reload();
	await expect(page.getByRole("switch").first()).not.toBeChecked();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: proofPath(
			"test-coverage-sweep-20260924/evidence/gateway-network-enable-error.png"
		),
	});
});

test("saves the Headscale URL and restores it after reload", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?backend=headscale&loginServer=https%3A%2F%2Fold.example`
	);
	const input = page.locator("#headscale-url");
	const save = page.getByRole("button", { name: "Save", exact: true });
	await expect(input).toHaveValue("https://old.example");
	await input.fill("https://hs.example.com");
	await save.click();
	await expect(page.getByText("Headscale server saved")).toBeVisible();
	await expect(save).toBeEnabled();
	expect(
		await page.evaluate(() =>
			window.__meshProof.requests.filter(
				(request) =>
					request.method === "PUT" &&
					request.path === "/api/preferences/mesh-login-server"
			)
		)
	).toEqual([
		{
			body: { value: "https://hs.example.com" },
			method: "PUT",
			path: "/api/preferences/mesh-login-server",
		},
	]);
	await page.reload();
	await expect(page.locator("#headscale-url")).toHaveValue(
		"https://hs.example.com"
	);
	expect(
		await page.evaluate(() =>
			window.__meshProof.requests.some(
				(request) =>
					request.method === "GET" &&
					request.path === "/api/preferences/mesh-login-server"
			)
		)
	).toBe(true);
});

test("retains and retries a Headscale URL after a failed write", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?backend=headscale&loginServer=https%3A%2F%2Fold.example&failPreferenceWrite=true`
	);
	const input = page.locator("#headscale-url");
	const save = page.getByRole("button", { name: "Save", exact: true });
	await expect(input).toHaveValue("https://old.example");
	await input.fill("https://denied.example.com");
	await save.click();
	await expect(
		page.getByText("Failed to save Headscale server URL")
	).toBeVisible();
	await expect(save).toBeEnabled();
	await expect(input).toHaveValue("https://denied.example.com");
	expect(await page.evaluate(() => window.__meshProof.loginServer)).toBe(
		"https://old.example"
	);
	expect(
		await page.evaluate(() =>
			window.__meshProof.requests.filter(
				(request) =>
					request.method === "PUT" &&
					request.path === "/api/preferences/mesh-login-server"
			)
		)
	).toEqual([
		{
			body: { value: "https://denied.example.com" },
			method: "PUT",
			path: "/api/preferences/mesh-login-server",
		},
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: proofPath(
			"test-coverage-sweep-20260924/evidence/gateway-headscale-save-error.png"
		),
	});
	await page.evaluate(() => {
		window.__meshProof.failPreferenceWrite = false;
	});
	await save.click();
	await expect(page.getByText("Headscale server saved")).toBeVisible();
	expect(
		await page.evaluate(() =>
			window.__meshProof.requests.filter(
				(request) =>
					request.method === "PUT" &&
					request.path === "/api/preferences/mesh-login-server"
			)
		)
	).toEqual([
		{
			body: { value: "https://denied.example.com" },
			method: "PUT",
			path: "/api/preferences/mesh-login-server",
		},
		{
			body: { value: "https://denied.example.com" },
			method: "PUT",
			path: "/api/preferences/mesh-login-server",
		},
	]);
	await page.reload();
	await expect(page.locator("#headscale-url")).toHaveValue(
		"https://denied.example.com"
	);
});

test("validates Headscale URLs before writes and trims a valid saved URL", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?backend=headscale&loginServer=https%3A%2F%2Fold.example`
	);
	const input = page.getByRole("textbox", {
		name: "Headscale control server URL",
	});
	const save = page.getByRole("button", { name: "Save", exact: true });
	await expect(input).toHaveValue("https://old.example");
	await expect(save).toBeEnabled();

	for (const { message, value } of [
		{
			message: "Enter the Headscale control server URL.",
			value: "",
		},
		{
			message: "Enter a valid HTTP or HTTPS URL.",
			value: "not a URL",
		},
		{
			message: "Enter a valid HTTP or HTTPS URL.",
			value: "ftp://hs.example.com",
		},
	]) {
		await input.fill(value);
		await expect(input).toHaveAttribute("aria-invalid", "true");
		await expect(page.getByRole("alert")).toHaveText(message);
		await expect(save).toBeDisabled();
	}
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: proofPath(
			"test-coverage-sweep-20260924/evidence/gateway-headscale-url-invalid.png"
		),
	});
	expect(await page.evaluate(() => window.__meshProof.loginServer)).toBe(
		"https://old.example"
	);
	expect(
		await page.evaluate(() =>
			window.__meshProof.requests.filter(
				(request) =>
					request.method === "PUT" &&
					request.path === "/api/preferences/mesh-login-server"
			)
		)
	).toEqual([]);

	await input.fill("  https://hs.example.com  ");
	await expect(input).toHaveAttribute("aria-invalid", "false");
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(save).toBeEnabled();
	await save.click();
	await expect(page.getByText("Headscale server saved")).toBeVisible();
	await expect(input).toHaveValue("https://hs.example.com");
	expect(await page.evaluate(() => window.__meshProof.loginServer)).toBe(
		"https://hs.example.com"
	);
	expect(
		await page.evaluate(() =>
			window.__meshProof.requests.filter(
				(request) =>
					request.method === "PUT" &&
					request.path === "/api/preferences/mesh-login-server"
			)
		)
	).toEqual([
		{
			body: { value: "https://hs.example.com" },
			method: "PUT",
			path: "/api/preferences/mesh-login-server",
		},
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: proofPath(
			"test-coverage-sweep-20260924/evidence/gateway-headscale-url-validated.png"
		),
	});
	await page.reload();
	await expect(
		page.getByRole("textbox", { name: "Headscale control server URL" })
	).toHaveValue("https://hs.example.com");
	expect(
		await page.evaluate(() =>
			window.__meshProof.requests.some(
				(request) =>
					request.method === "GET" &&
					request.path === "/api/preferences/mesh-login-server"
			)
		)
	).toBe(true);
});
