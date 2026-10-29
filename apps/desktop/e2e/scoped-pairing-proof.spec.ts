import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ScopedPairingProofPublisher } from "./harness/scoped-pairing-proof.mock.ts";

declare const window: Window & {
	__SCOPED_PAIRING_PROOF__: ScopedPairingProofPublisher;
};

type PairingProofSnapshot = Pick<
	ScopedPairingProofPublisher,
	| "browserPairName"
	| "lastApproval"
	| "lastDeniedUserCode"
	| "lastRevokedClientId"
	| "requests"
	| "rotationCount"
>;

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
const PROOF_DIRECTORY =
	process.env.RYU_PROOF_EVIDENCE_DIR ??
	path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence"
	);

/**
 * The waiting request's human code. NodeAccessSettings renders it through the
 * shared read-only OTP display (one labelled input holding the normalized
 * characters), so the code is read from that control rather than as text.
 */
function pairingCode(page: Page) {
	return page.getByRole("textbox", { name: "Research browser pairing code" });
}

function screenshotPath(name: string): string {
	return path.join(PROOF_DIRECTORY, name);
}

async function readProofState(page: Page): Promise<PairingProofSnapshot> {
	return page.evaluate(() => {
		const {
			browserPairName,
			lastApproval,
			lastDeniedUserCode,
			lastRevokedClientId,
			requests,
			rotationCount,
		} = window.__SCOPED_PAIRING_PROOF__;
		return {
			browserPairName,
			lastApproval,
			lastDeniedUserCode,
			lastRevokedClientId,
			requests,
			rotationCount,
		};
	});
}

test("scoped pairing narrows, grants, and revokes access", async ({ page }) => {
	const browserErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => browserErrors.push(String(error)));

	await page.goto("/scoped-pairing-proof.html");
	await expect(page.locator('body[data-harness-ready="1"]')).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Devices waiting to connect" })
	).toBeVisible();
	await expect(
		page.getByText("Research browser", { exact: true })
	).toBeVisible();
	await expect(pairingCode(page)).toHaveValue("J7KPQM");
	await expect(
		page.getByText(
			"Binding: Organization: org-proof, Team: team-proof, Plugin: com.ryu.search, Tool: search",
			{ exact: true }
		)
	).toBeVisible();
	await expect(page.getByText(/^Expires /).first()).toBeVisible();

	const grantGroup = page.getByRole("group", { name: "Grant access" });
	await expect(
		grantGroup.getByRole("checkbox", { name: "chat:read" })
	).toBeChecked();
	await expect(
		grantGroup.getByRole("checkbox", { name: "chat:write" })
	).toBeChecked();
	await expect(
		grantGroup.getByRole("checkbox", { name: "tools:read" })
	).toBeChecked();
	await grantGroup.getByRole("checkbox", { name: "chat:write" }).uncheck();
	await expect(
		grantGroup.getByRole("checkbox", { name: "chat:write" })
	).not.toBeChecked();

	await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();
	await expect(page.getByText("Expired", { exact: true })).toBeVisible();
	await expect(page.getByText("Inactive", { exact: true })).toBeVisible();
	await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Revoke Expired CI runner" })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Revoke Inactive tablet" })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Revoke Revoked browser" })
	).toHaveCount(0);

	await page
		.getByRole("button", {
			name: "Approve Research browser with requested access",
		})
		.click();
	await expect(
		page.getByText("Research browser", { exact: true })
	).toBeVisible();
	await expect(pairingCode(page)).toHaveCount(0);
	let proofState = await readProofState(page);
	expect(proofState.lastApproval).toEqual({
		granted_scopes: ["chat:read", "tools:read"],
		user_code: "J7K-PQM",
	});

	const researchRow = page
		.locator("li")
		.filter({ has: page.getByText("Research browser", { exact: true }) });
	const grantedAccess = researchRow.getByRole("list", {
		name: "Granted access",
	});
	await expect(
		grantedAccess.getByText("chat:read", { exact: true })
	).toBeVisible();
	await expect(
		grantedAccess.getByText("tools:read", { exact: true })
	).toBeVisible();
	await expect(
		grantedAccess.getByText("chat:write", { exact: true })
	).toHaveCount(0);

	await page.getByRole("button", { name: "Revoke VS Code MCP" }).click();
	const vscodeRow = page
		.locator("li")
		.filter({ has: page.getByText("VS Code MCP", { exact: true }) });
	await expect(vscodeRow.getByText("Revoked", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Revoke VS Code MCP" })
	).toHaveCount(0);
	proofState = await readProofState(page);
	expect(proofState.lastRevokedClientId).toBe("client-vscode");
	expect(
		proofState.requests.filter(
			(request) =>
				request.path.startsWith("/api/pair/") && request.method !== "GET"
		)
	).toEqual([
		{
			body: {
				granted_scopes: ["chat:read", "tools:read"],
				user_code: "J7K-PQM",
			},
			method: "POST",
			path: "/api/pair/approve",
			status: 200,
			target: {
				token: "owner-proof-token",
				url: "http://proof.local",
				userJwt: null,
			},
		},
		{
			body: null,
			method: "DELETE",
			path: "/api/pair/clients/client-vscode",
			status: 200,
			target: {
				token: "owner-proof-token",
				url: "http://proof.local",
				userJwt: null,
			},
		},
	]);

	await mkdir(PROOF_DIRECTORY, { recursive: true });
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("desktop-node-access-approval-revocation.png"),
	});
	expect(browserErrors).toEqual([]);
});

test("failed scoped approval keeps the request and narrowed grant for an exact retry", async ({
	page,
}) => {
	await page.goto("/scoped-pairing-proof.html");
	await expect(
		page.getByText("Research browser", { exact: true })
	).toBeVisible();

	const grantGroup = page.getByRole("group", { name: "Grant access" });
	await grantGroup.getByRole("checkbox", { name: "chat:write" }).uncheck();
	await page.evaluate(() => {
		window.__SCOPED_PAIRING_PROOF__.failNextRequest(
			"POST",
			"/api/pair/approve"
		);
	});

	const approve = page.getByRole("button", {
		name: "Approve Research browser with requested access",
	});
	await approve.click();
	await expect(page.getByText("Could not record that decision")).toBeVisible();
	await expect(pairingCode(page)).toHaveValue("J7KPQM");
	await expect(
		grantGroup.getByRole("checkbox", { name: "chat:read" })
	).toBeChecked();
	await expect(
		grantGroup.getByRole("checkbox", { name: "chat:write" })
	).not.toBeChecked();
	await expect(
		grantGroup.getByRole("checkbox", { name: "tools:read" })
	).toBeChecked();

	let state = await readProofState(page);
	expect(
		state.requests
			.filter((request) => request.path === "/api/pair/approve")
			.map(({ body, method, status }) => ({ body, method, status }))
	).toEqual([
		{
			body: {
				granted_scopes: ["chat:read", "tools:read"],
				user_code: "J7K-PQM",
			},
			method: "POST",
			status: 503,
		},
	]);
	await expect(approve).toBeEnabled();

	await approve.click();
	await expect(pairingCode(page)).toHaveCount(0);
	await expect(
		page.getByText("Device approved", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Could not record that decision", { exact: true })
	).toHaveCount(0);
	const researchRow = page
		.locator("li")
		.filter({ has: page.getByText("Research browser", { exact: true }) });
	const grantedAccess = researchRow.getByRole("list", {
		name: "Granted access",
	});
	await expect(
		grantedAccess.getByText("chat:read", { exact: true })
	).toBeVisible();
	await expect(
		grantedAccess.getByText("tools:read", { exact: true })
	).toBeVisible();
	await expect(
		grantedAccess.getByText("chat:write", { exact: true })
	).toHaveCount(0);

	state = await readProofState(page);
	expect(
		state.requests
			.filter((request) => request.path === "/api/pair/approve")
			.map(({ body, method, status }) => ({ body, method, status }))
	).toEqual([
		{
			body: {
				granted_scopes: ["chat:read", "tools:read"],
				user_code: "J7K-PQM",
			},
			method: "POST",
			status: 503,
		},
		{
			body: {
				granted_scopes: ["chat:read", "tools:read"],
				user_code: "J7K-PQM",
			},
			method: "POST",
			status: 200,
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("desktop-node-access-approval-retry.png"),
	});
});

test("device-access read failure is visibly distinct and retries to the fixture state", async ({
	page,
}) => {
	await page.goto("/scoped-pairing-proof.html?failPendingRead=1");
	await expect(page.locator('body[data-harness-ready="1"]')).toBeVisible();
	await expect(
		page.getByText("Could not load device access", { exact: false })
	).toBeVisible();
	await expect(page.getByText("Nothing waiting.", { exact: true })).toHaveCount(
		0
	);
	await expect(
		page.getByText("No paired devices.", { exact: true })
	).toHaveCount(0);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("desktop-node-access-read-unavailable.png"),
	});
	let proofState = await readProofState(page);
	expect(
		proofState.requests.find(
			(request) =>
				request.method === "GET" && request.path === "/api/pair/requests"
		)
	).toMatchObject({ status: 503 });

	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(
		page.getByText("Research browser", { exact: true })
	).toBeVisible();
	await expect(page.getByText("VS Code MCP", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Could not load device access", { exact: false })
	).toHaveCount(0);
	proofState = await readProofState(page);
	const requestReads = proofState.requests.filter(
		(request) =>
			request.method === "GET" && request.path === "/api/pair/requests"
	);
	expect(
		requestReads.map(({ status, target }) => ({ status, target }))
	).toEqual([
		{
			status: 503,
			target: {
				token: "owner-proof-token",
				url: "http://proof.local",
				userJwt: null,
			},
		},
		{
			status: 200,
			target: {
				token: "owner-proof-token",
				url: "http://proof.local",
				userJwt: null,
			},
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("desktop-node-access-load-retry-recovered.png"),
	});
});

test("deny sends only the user code, locks decisions while pending, and retains the request for retry", async ({
	page,
}) => {
	await page.goto("/scoped-pairing-proof.html");
	await expect(
		page.getByText("Research browser", { exact: true })
	).toBeVisible();
	const deny = page.getByRole("button", { name: "Deny Research browser" });
	const approve = page.getByRole("button", {
		name: "Approve Research browser with requested access",
	});
	await page.evaluate(() => {
		window.__SCOPED_PAIRING_PROOF__.holdNextRequest("POST", "/api/pair/deny");
	});
	await deny.click();
	await expect(deny).toBeDisabled();
	await expect(approve).toBeDisabled();
	let state = await readProofState(page);
	expect(state.requests.at(-1)).toMatchObject({
		body: { user_code: "J7K-PQM" },
		method: "POST",
		path: "/api/pair/deny",
		status: null,
		target: {
			token: "owner-proof-token",
			url: "http://proof.local",
			userJwt: null,
		},
	});
	await page.evaluate(() =>
		window.__SCOPED_PAIRING_PROOF__.resolveHeldRequest(true)
	);
	await expect(page.getByText("Could not record that decision")).toBeVisible();
	await expect(pairingCode(page)).toHaveValue("J7KPQM");

	await deny.click();
	await expect(pairingCode(page)).toHaveCount(0);
	await expect(page.getByText("Research browser", { exact: true })).toHaveCount(
		0
	);
	state = await readProofState(page);
	expect(state.lastDeniedUserCode).toBe("J7K-PQM");
	expect(
		state.requests
			.filter((request) => request.method === "POST")
			.map(({ body, path, status }) => ({ body, path, status }))
	).toEqual([
		{
			body: { user_code: "J7K-PQM" },
			path: "/api/pair/deny",
			status: 503,
		},
		{
			body: { user_code: "J7K-PQM" },
			path: "/api/pair/deny",
			status: 200,
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("desktop-node-access-denied-retry.png"),
	});
});

test("owner token show/copy and rotation retry expose the persisted local token", async ({
	page,
}) => {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.goto("/scoped-pairing-proof.html");
	const token = page.getByLabel("Token");
	await expect(token).toHaveValue("owner-proof-token");
	await expect(token).toHaveAttribute("readonly", "");
	await expect(token).toHaveAttribute("type", "password");
	await page.getByRole("button", { name: "Show", exact: true }).click();
	await expect(token).toHaveAttribute("type", "text");
	await page.getByRole("button", { name: "Hide", exact: true }).click();
	await expect(token).toHaveAttribute("type", "password");
	await page.getByRole("button", { name: "Copy", exact: true }).click();
	await expect(page.getByText("Token copied", { exact: true })).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		"owner-proof-token"
	);

	await page.evaluate(() => {
		window.__SCOPED_PAIRING_PROOF__.failNextRequest(
			"POST",
			"/api/node/token/rotate"
		);
	});
	await page.getByRole("button", { name: "Rotate token", exact: true }).click();
	await expect(page.getByText("Could not rotate the token")).toBeVisible();
	await expect(token).toHaveValue("owner-proof-token");
	await page.getByRole("button", { name: "Rotate token", exact: true }).click();
	await expect(
		page.getByText("Owner token rotated", { exact: true })
	).toBeVisible();
	await expect(token).toHaveValue("rotated-owner-proof-token");
	const state = await readProofState(page);
	expect(state.rotationCount).toBe(1);
	expect(
		state.requests
			.filter((request) => request.path === "/api/node/token/rotate")
			.map(({ body, method, status, target }) => ({
				body,
				method,
				status,
				target,
			}))
	).toEqual([
		{
			body: null,
			method: "POST",
			status: 503,
			target: {
				token: "owner-proof-token",
				url: "http://proof.local",
				userJwt: null,
			},
		},
		{
			body: null,
			method: "POST",
			status: 200,
			target: {
				token: "owner-proof-token",
				url: "http://proof.local",
				userJwt: null,
			},
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("desktop-node-access-token-rotated.png"),
	});
});

test("environment owner token cannot be rotated in Desktop", async ({
	page,
}) => {
	await page.goto("/scoped-pairing-proof.html?source=env");
	await expect(page.getByLabel("Token")).toHaveValue("owner-proof-token");
	await expect(page.getByRole("button", { name: "Rotate token" })).toHaveCount(
		0
	);
	await expect(
		page.getByText(/comes from the RYU_TOKEN environment variable/i)
	).toBeVisible();
	const state = await readProofState(page);
	expect(
		state.requests.filter(
			(request) => request.path === "/api/node/token/rotate"
		)
	).toEqual([]);
});

test("browser pairing shows the human code and reloads onto the paired node token", async ({
	page,
}) => {
	await page.goto("/scoped-pairing-proof.html?browser=1");
	await expect(
		page.getByRole("heading", { name: "Connect this browser" })
	).toBeVisible();
	await page.getByRole("button", { name: "Connect this browser" }).click();
	await expect(page.getByRole("status")).toContainText("N4H-RQX");
	await expect(page.getByRole("status")).toContainText(
		"Waiting for approval in the desktop app"
	);
	let state = await readProofState(page);
	expect(state.browserPairName).toBe("Secure workstation");
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("desktop-node-access-browser-pairing-code.png"),
	});
	const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded" });
	await page.evaluate(() =>
		window.__SCOPED_PAIRING_PROOF__.resolveBrowserPairing(true)
	);
	await navigation;
	await expect(
		page.getByRole("heading", { name: "Connect this browser" })
	).toBeVisible();
	await page.waitForFunction(() =>
		window.__SCOPED_PAIRING_PROOF__.requests.some(
			(request) => request.target.token === "browser-paired-proof-token"
		)
	);
	state = await readProofState(page);
	expect(
		state.requests
			.filter(
				(request) => request.target.token === "browser-paired-proof-token"
			)
			.map(({ method, path, status, target }) => ({
				method,
				path,
				status,
				target,
			}))
	).toEqual([
		{
			method: "GET",
			path: "/api/pair/requests",
			status: 200,
			target: {
				token: "browser-paired-proof-token",
				url: "http://proof.local",
				userJwt: null,
			},
		},
		{
			method: "GET",
			path: "/api/pair/clients",
			status: 200,
			target: {
				token: "browser-paired-proof-token",
				url: "http://proof.local",
				userJwt: null,
			},
		},
	]);
});
