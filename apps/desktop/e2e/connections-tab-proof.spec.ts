import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
}

interface CapturedTauriCall {
	args: unknown;
	command: string;
}

interface ProofNode {
	managed?: boolean;
	name: string;
	orgId?: string | null;
	serverId?: string | null;
	token: string | null;
	url: string;
	userJwt?: string | null;
}

interface ProofConnection {
	client_id: string;
	client_label: string | null;
	first_seen: number;
	last_seen: number;
	surface: string | null;
	user_id: string | null;
	user_name: string | null;
}

interface ConnectionsProofWindow extends Window {
	__connectionsTabProof: {
		armFailure: (key: string) => void;
		consumeFailure: (key: string) => boolean;
		recordRequest: (request: CapturedRequest) => void;
		replaceAccounts: (accounts: { accountId?: string }[]) => void;
		replaceConnections: (connections: ProofConnection[]) => void;
		snapshot: () => {
			accounts: { accountId?: string }[];
			calls: CapturedRequest[];
			connections: ProofConnection[];
			defaultNode: string;
			nodes: ProofNode[];
			sshProfiles: string | null;
			tauriCalls: CapturedTauriCall[];
		};
	};
}

const sshProfilesSchema = z.array(
	z.object({
		auth: z.string(),
		host: z.string(),
		id: z.string(),
		identityFile: z.string().optional(),
		name: z.string(),
		port: z.number(),
		username: z.string(),
	})
);

async function openConnections(
	page: Page,
	query = ""
): Promise<{
	dialog: ReturnType<Page["locator"]>;
	hub: ReturnType<Page["getByTestId"]>;
}> {
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(`/connections-tab-proof.html${query}`);
	await expect(page.locator("body")).toHaveAttribute(
		"data-harness-ready",
		"1",
		{
			timeout: 30_000,
		}
	);
	return revealConnections(page);
}

async function installAuthFixture(page: Page): Promise<void> {
	await page.route("**/api/auth/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const method = request.method();
		let body: unknown;
		try {
			body = request.postDataJSON();
		} catch {
			body = request.postData();
		}
		await page.evaluate(
			(entry) =>
				/* SAFETY: connections-tab-proof.tsx installs __connectionsTabProof before this proof page is evaluated. */ (
					window as ConnectionsProofWindow
				).__connectionsTabProof.recordRequest(entry),
			{ body, method, path: url.pathname }
		);
		const corsHeaders = {
			"access-control-allow-credentials": "true",
			"access-control-allow-headers": "authorization,content-type",
			"access-control-allow-methods": "GET,POST,OPTIONS",
			"access-control-allow-origin":
				request.headers().origin ?? "http://127.0.0.1:5307",
			"access-control-max-age": "600",
			vary: "Origin",
		};
		if (method === "OPTIONS") {
			await route.fulfill({ headers: corsHeaders, status: 204 });
			return;
		}
		if (url.pathname.endsWith("/list-accounts") && method === "GET") {
			const accounts = await page.evaluate(
				() =>
					/* SAFETY: connections-tab-proof.tsx installs __connectionsTabProof before this proof page is evaluated. */ (
						window as ConnectionsProofWindow
					).__connectionsTabProof.snapshot().accounts
			);
			await route.fulfill({
				body: JSON.stringify(accounts),
				contentType: "application/json",
				headers: corsHeaders,
				status: 200,
			});
			return;
		}
		if (url.pathname.endsWith("/link-social") && method === "POST") {
			const failed = await page.evaluate(() =>
				/* SAFETY: connections-tab-proof.tsx installs __connectionsTabProof before this proof page is evaluated. */ (
					window as ConnectionsProofWindow
				).__connectionsTabProof.consumeFailure("link-social")
			);
			await route.fulfill({
				body: JSON.stringify(
					failed
						? { message: "Identity service is unavailable" }
						: {
								url: "https://identity.fixture.test/authorize?flow=connections-proof",
								redirect: !z
									.object({ disableRedirect: z.boolean().optional() })
									.parse(body).disableRedirect,
							}
				),
				contentType: "application/json",
				headers: corsHeaders,
				status: failed ? 503 : 200,
			});
			return;
		}
		if (url.pathname.endsWith("/unlink-account") && method === "POST") {
			const failed = await page.evaluate(() =>
				/* SAFETY: connections-tab-proof.tsx installs __connectionsTabProof before this proof page is evaluated. */ (
					window as ConnectionsProofWindow
				).__connectionsTabProof.consumeFailure("unlink-account")
			);
			if (failed) {
				await route.fulfill({
					body: JSON.stringify({ message: "Account permission check failed" }),
					contentType: "application/json",
					headers: corsHeaders,
					status: 403,
				});
				return;
			}
			const accountId =
				z.object({ accountId: z.string().optional() }).parse(body ?? {})
					.accountId ?? null;
			await page.evaluate((id) => {
				const proof =
					/* SAFETY: connections-tab-proof.tsx installs __connectionsTabProof before this proof page is evaluated. */ (
						window as ConnectionsProofWindow
					).__connectionsTabProof;
				const accounts = proof.snapshot().accounts;
				proof.replaceAccounts(
					accounts.filter((account) => account.accountId !== id)
				);
			}, accountId);
			await route.fulfill({
				body: JSON.stringify({ status: true }),
				contentType: "application/json",
				headers: corsHeaders,
				status: 200,
			});
			return;
		}
		await route.fulfill({
			body: JSON.stringify({ session: null, user: null }),
			contentType: "application/json",
			headers: corsHeaders,
			status: 200,
		});
	});
}

async function revealConnections(page: Page): Promise<{
	dialog: ReturnType<Page["locator"]>;
	hub: ReturnType<Page["getByTestId"]>;
}> {
	const dialog = page.locator('[data-slot="dialog-content"]').first();
	await expect(dialog).toBeVisible();
	await dialog
		.getByRole("button", { name: "Connections", exact: true })
		.click();
	const hub = dialog.getByTestId("connections-hub");
	await expect(hub).toBeVisible();
	return { dialog, hub };
}

async function proofSnapshot(page: Page) {
	return page.evaluate(() =>
		/* SAFETY: connections-tab-proof.tsx installs __connectionsTabProof before this proof page is evaluated. */ (
			window as ConnectionsProofWindow
		).__connectionsTabProof.snapshot()
	);
}

async function armFailure(page: Page, key: string): Promise<void> {
	await page.evaluate((failureKey) => {
		/* SAFETY: connections-tab-proof.tsx installs __connectionsTabProof before this proof page is evaluated. */ (
			window as ConnectionsProofWindow
		).__connectionsTabProof.armFailure(failureKey);
	}, key);
}

test.describe.configure({ timeout: 90_000 });

test("adds remote nodes with required fields, exact native payload, retry, and reload persistence", async ({
	page,
}, testInfo) => {
	const { hub } = await openConnections(page, "?reset=true&emptyNodes=true");
	const thisDevice = hub.getByRole("tab", {
		name: "Control this device",
		exact: true,
	});
	await expect(thisDevice).toHaveAttribute("aria-selected", "true");
	await thisDevice.click();
	const otherDevices = hub.getByRole("tab", {
		name: "Control other devices",
		exact: true,
	});
	await otherDevices.click();
	await expect(
		hub.getByRole("heading", { name: "Remote nodes", exact: true })
	).toBeVisible();

	const addRemote = hub.getByRole("button", {
		name: "Add remote",
		exact: true,
	});
	await addRemote.click();
	const remoteDialog = page.getByRole("dialog", { name: "Add remote node" });
	await expect(remoteDialog).toBeVisible();
	const name = remoteDialog.getByRole("textbox", { name: "Display name" });
	const url = remoteDialog.getByRole("textbox", { name: "Node URL" });
	const token = remoteDialog.getByLabel("Access token (optional)");
	const submit = remoteDialog.getByRole("button", {
		name: "Add remote",
		exact: true,
	});
	await expect(submit).toBeDisabled();
	await remoteDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(remoteDialog).not.toBeVisible();

	await addRemote.click();
	await expect(remoteDialog).toBeVisible();
	await expect(name).toHaveValue("");
	await expect(url).toHaveValue("");
	await expect(token).toHaveValue("");
	await name.fill("  Build node  ");
	await url.fill("  https://build.example.test:7980/  ");
	await token.fill("  build-node-secret  ");
	await expect(submit).toBeEnabled();

	await armFailure(page, "add_node");
	await submit.click();
	await expect(remoteDialog.getByRole("alert")).toHaveText(
		"Fixture denied add_node"
	);
	await expect(name).toHaveValue("  Build node  ");
	await expect(url).toHaveValue("  https://build.example.test:7980/  ");
	await expect(token).toHaveValue("  build-node-secret  ");
	await expect((await proofSnapshot(page)).nodes).toHaveLength(1);

	await submit.click();
	await expect(remoteDialog).not.toBeVisible();
	await otherDevices.click();
	await expect(hub.getByText("Build node", { exact: true })).toBeVisible();
	const added = await proofSnapshot(page);
	const initialNodeReads = added.tauriCalls.filter(
		(call) => call.command === "list_nodes"
	).length;
	expect(initialNodeReads).toBeGreaterThan(0);
	expect(
		added.tauriCalls
			.filter((call) => call.command === "add_node")
			.map((call) => call.args)
	).toEqual([
		{
			name: "Build node",
			token: "build-node-secret",
			url: "https://build.example.test:7980/",
		},
		{
			name: "Build node",
			token: "build-node-secret",
			url: "https://build.example.test:7980/",
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("connections-remote-node-added.png"),
	});

	await page.reload();
	const reloaded = await revealConnections(page);
	await reloaded.hub
		.getByRole("tab", { name: "Control other devices", exact: true })
		.click();
	await expect(
		reloaded.hub.getByText("Build node", { exact: true })
	).toBeVisible();
	const afterReload = await proofSnapshot(page);
	expect(
		afterReload.tauriCalls.filter((call) => call.command === "list_nodes")
			.length
	).toBeGreaterThan(initialNodeReads);
	expect(afterReload.nodes).toContainEqual({
		name: "Build node",
		token: "build-node-secret",
		url: "https://build.example.test:7980/",
	});
	await expect(
		reloaded.dialog.getByRole("button", { name: "Connections" })
	).toBeVisible();
});

test("switches remote nodes and removes a managed node with permission-error recovery and persistence", async ({
	page,
}, testInfo) => {
	const { hub } = await openConnections(page, "?reset=true");
	const otherDevices = hub.getByRole("tab", {
		name: "Control other devices",
		exact: true,
	});
	await otherDevices.click();
	const privateNode = hub.getByText("Private build node", { exact: true });
	await expect(privateNode).toBeVisible();
	const useNode = hub.getByRole("button", { name: "Use", exact: true }).first();
	await armFailure(page, "set_default_node");
	await useNode.click();
	await expect(
		page.getByText("Could not switch nodes", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Fixture denied set_default_node", { exact: true })
	).toBeVisible();
	await expect(useNode).toBeEnabled();
	await useNode.click();
	await otherDevices.click();
	await expect(hub.getByText("Active", { exact: true })).toBeVisible();
	let snapshot = await proofSnapshot(page);
	expect(snapshot.defaultNode).toBe("Private build node");
	expect(
		snapshot.tauriCalls
			.filter((call) => call.command === "set_default_node")
			.map((call) => call.args)
	).toEqual([{ name: "Private build node" }, { name: "Private build node" }]);
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("connections-remote-managed-node-active.png"),
	});

	const managedNode = hub.getByText("Managed cloud node", { exact: true });
	await expect(managedNode).toBeVisible();
	expect(
		(await proofSnapshot(page)).nodes.find(
			(node) => node.name === "Managed cloud node"
		)
	).toMatchObject({
		managed: true,
		orgId: "proof-org",
		serverId: "proof-server",
	});
	await armFailure(page, "remove_node");
	await hub.getByRole("button", { name: "Remove Managed cloud node" }).click();
	await expect(
		page.getByText("Could not remove node", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Fixture denied remove_node", { exact: true })
	).toBeVisible();
	await expect(managedNode).toBeVisible();
	await hub.getByRole("button", { name: "Remove Managed cloud node" }).click();
	await expect(managedNode).toHaveCount(0);
	snapshot = await proofSnapshot(page);
	expect(
		snapshot.tauriCalls
			.filter((call) => call.command === "remove_node")
			.map((call) => call.args)
	).toEqual([{ name: "Managed cloud node" }, { name: "Managed cloud node" }]);
	await page.reload();
	const reloaded = await revealConnections(page);
	await reloaded.hub
		.getByRole("tab", { name: "Control other devices", exact: true })
		.click();
	await expect(
		reloaded.hub.getByText("Managed cloud node", { exact: true })
	).toHaveCount(0);
	await expect(reloaded.hub.getByText("Active", { exact: true })).toBeVisible();
	await expect(
		(await proofSnapshot(page)).nodes.map((node) => node.name)
	).toEqual(["local", "Private build node"]);
});

test("connected-device presence retries after a node error and distinguishes this device from peers", async ({
	page,
}, testInfo) => {
	const { hub } = await openConnections(
		page,
		"?reset=true&connectionsError=true"
	);
	const presence = hub
		.getByRole("heading", { name: "Connected devices", exact: true })
		.nth(1)
		.locator("xpath=../..");
	await expect(
		presence.getByText(
			"Connected-device presence is unavailable on this node.",
			{ exact: true }
		)
	).toBeVisible();
	await expect(
		presence.getByText("No other devices have connected recently.", {
			exact: true,
		})
	).toHaveCount(0);

	const retry = presence.getByRole("button", {
		name: "Retry connected device presence",
		exact: true,
	});
	await expect(retry).toBeEnabled();
	const now = Math.floor(Date.now() / 1000);
	await page.evaluate(
		(connections) =>
			/* SAFETY: connections-tab-proof.tsx installs __connectionsTabProof before this proof page is evaluated. */ (
				window as ConnectionsProofWindow
			).__connectionsTabProof.replaceConnections(connections),
		[
			{
				client_id: "connections-proof-desktop",
				client_label: "Studio desktop",
				first_seen: now - 90,
				last_seen: now,
				surface: "desktop",
				user_id: "owner@example.test",
				user_name: "Ryu owner",
			},
			{
				client_id: "mobile-client-2",
				client_label: "Pixel phone",
				first_seen: now - 40,
				last_seen: now - 5,
				surface: "mobile",
				user_id: null,
				user_name: null,
			},
		]
	);
	await retry.click();

	const desktopRow = presence.locator('[data-slot="item"]').filter({
		hasText: "Ryu owner",
	});
	const phoneRow = presence.locator('[data-slot="item"]').filter({
		hasText: "Pixel phone",
	});
	await expect(desktopRow).toBeVisible();
	await expect(
		desktopRow.getByText("This device", { exact: true })
	).toBeVisible();
	await expect(phoneRow).toBeVisible();
	await expect(phoneRow.getByText("This device", { exact: true })).toHaveCount(
		0
	);
	await expect(phoneRow).toContainText("Mobile");
	await expect(
		presence.getByText(
			"Connected-device presence is unavailable on this node.",
			{ exact: true }
		)
	).toHaveCount(0);

	const snapshot = await proofSnapshot(page);
	expect(
		snapshot.calls.filter((call) => call.path === "/api/connections")
	).toEqual([
		{ body: null, method: "GET", path: "/api/connections" },
		{ body: null, method: "GET", path: "/api/connections" },
	]);
	expect(snapshot.connections).toHaveLength(2);
	await page.setViewportSize({ height: 1300, width: 1440 });
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("connections-device-presence-recovered.png"),
	});
});

test("validates, edits, persists, and removes SSH connection metadata without reading private keys", async ({
	page,
}, testInfo) => {
	const { hub } = await openConnections(page, "?reset=true&emptyNodes=true");
	const sshTab = hub.getByRole("tab", { name: "SSH", exact: true });
	await sshTab.click();
	await expect(
		hub.getByRole("heading", {
			name: "SSH connections from this device",
			exact: true,
		})
	).toBeVisible();
	const addManual = hub.getByRole("button", {
		name: "Add manually",
		exact: true,
	});
	await addManual.click();
	let sshDialog = page.getByRole("dialog", { name: "Add SSH connection" });
	await expect(sshDialog).toBeVisible();
	const name = sshDialog.getByRole("textbox", { name: "Display name" });
	const host = sshDialog.getByRole("textbox", { name: "Hostname" });
	const username = sshDialog.getByRole("textbox", { name: "Username" });
	const port = sshDialog.getByRole("textbox", { name: "SSH port" });
	await name.fill("Discarded draft");
	await sshDialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(sshDialog).not.toBeVisible();
	await expect(await proofSnapshot(page)).toMatchObject({ sshProfiles: null });
	await addManual.click();
	sshDialog = page.getByRole("dialog", { name: "Add SSH connection" });
	await expect(
		sshDialog.getByRole("textbox", { name: "Display name" })
	).toHaveValue("");
	await name.fill(" Release builder ");
	await host.fill(" deploy@build.example.test ");
	await port.fill("65536");
	await sshDialog.getByRole("button", { name: "Save connection" }).click();
	await expect(sshDialog.getByRole("alert")).toHaveText(
		"Enter a display name, valid host, and port from 1 to 65535"
	);
	await expect(await proofSnapshot(page)).toMatchObject({ sshProfiles: null });
	await expect(username).toHaveValue("");

	await port.fill("2222");
	await sshDialog
		.getByRole("button", { name: "Identity file", exact: true })
		.click();
	const identityFile = sshDialog.getByRole("textbox", {
		name: "Identity file path",
	});
	await sshDialog.getByRole("button", { name: "Save connection" }).click();
	await expect(sshDialog.getByRole("alert")).toHaveText(
		"Choose an identity file path"
	);
	await identityFile.fill("~/.ssh/build_ed25519");
	await expect(identityFile).toHaveValue("~/.ssh/build_ed25519");
	await sshDialog.getByRole("button", { name: "Save connection" }).click();
	await expect(sshDialog).not.toBeVisible();
	await expect(hub.getByText("Release builder", { exact: true })).toBeVisible();
	let snapshot = await proofSnapshot(page);
	const storedProfiles = sshProfilesSchema.parse(
		JSON.parse(snapshot.sshProfiles ?? "[]")
	);
	expect(storedProfiles).toHaveLength(1);
	expect(storedProfiles[0]).toMatchObject({
		auth: "identity",
		host: "build.example.test",
		identityFile: "~/.ssh/build_ed25519",
		name: "Release builder",
		port: 2222,
		username: "deploy",
	});
	expect(storedProfiles[0]?.id).toMatch(/^[\w.-]+$/u);
	expect(
		snapshot.tauriCalls.some((call) => call.command.startsWith("ssh_"))
	).toBe(false);

	await addManual.click();
	sshDialog = page.getByRole("dialog", { name: "Add SSH connection" });
	await sshDialog
		.getByRole("textbox", { name: "Display name" })
		.fill("Dev host");
	await sshDialog
		.getByRole("textbox", { name: "Hostname" })
		.fill("dev.example.test");
	await sshDialog.getByRole("textbox", { name: "Username" }).fill("runner");
	const noAuth = sshDialog.getByRole("button", {
		name: "No auth",
		exact: true,
	});
	await noAuth.click();
	await expect(noAuth).toHaveAttribute("aria-pressed", "true");
	await sshDialog.getByRole("button", { name: "Save connection" }).click();
	await expect(sshDialog).not.toBeVisible();
	await expect(hub.getByText("Dev host", { exact: true })).toBeVisible();
	snapshot = await proofSnapshot(page);
	const twoProfiles = sshProfilesSchema.parse(
		JSON.parse(snapshot.sshProfiles ?? "[]")
	);
	expect(twoProfiles[1]).toMatchObject({
		auth: "none",
		host: "dev.example.test",
		name: "Dev host",
		port: 22,
		username: "runner",
	});
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("connections-ssh-profiles-saved.png"),
	});

	const releaseRow = hub.locator('[data-slot="item"]').filter({
		hasText: "Release builder",
	});
	await releaseRow.getByRole("button", { name: "Edit", exact: true }).click();
	sshDialog = page.getByRole("dialog", { name: "Edit SSH connection" });
	await sshDialog
		.getByRole("textbox", { name: "Display name" })
		.fill("Release host");
	await sshDialog.getByRole("textbox", { name: "SSH port" }).fill("2223");
	await sshDialog.getByRole("button", { name: "Save connection" }).click();
	await expect(hub.getByText("Release host", { exact: true })).toBeVisible();
	const updated = sshProfilesSchema.parse(
		JSON.parse((await proofSnapshot(page)).sshProfiles ?? "[]")
	);
	expect(updated[0]).toMatchObject({
		id: storedProfiles[0]?.id,
		name: "Release host",
		port: 2223,
	});

	await hub
		.locator('[data-slot="item"]')
		.filter({ hasText: "Release host" })
		.getByRole("button", { name: "Remove Release host" })
		.click();
	await expect(hub.getByText("Release host", { exact: true })).toHaveCount(0);
	await page.reload();
	const reloaded = await revealConnections(page);
	await reloaded.hub.getByRole("tab", { name: "SSH", exact: true }).click();
	await expect(
		reloaded.hub.getByText("Dev host", { exact: true })
	).toBeVisible();
	await expect(
		reloaded.hub.getByText("Release host", { exact: true })
	).toHaveCount(0);
	const afterReload = await proofSnapshot(page);
	expect(JSON.parse(afterReload.sshProfiles ?? "[]")).toHaveLength(1);
});

test("links and unlinks social accounts through local auth fixtures with permission recovery", async ({
	page,
}, testInfo) => {
	await installAuthFixture(page);
	const { hub } = await openConnections(page, "?reset=true&emptyNodes=true");
	const webviewUrl = page.url();
	const navigations: string[] = [];
	page.on("framenavigated", (frame) => {
		if (frame === page.mainFrame()) {
			navigations.push(frame.url());
		}
	});
	const linkedAccountsHeading = hub.getByRole("heading", {
		name: "Linked accounts",
		exact: true,
	});
	await expect(linkedAccountsHeading).toBeVisible();
	const githubLink = hub.getByRole("button", {
		name: "Link GitHub account",
		exact: true,
	});
	await expect(githubLink).toBeEnabled();
	await armFailure(page, "link-social");
	await githubLink.click();
	await expect
		.poll(
			async () =>
				(await proofSnapshot(page)).calls.filter((call) =>
					call.path.endsWith("/api/auth/link-social")
				).length
		)
		.toBe(1);
	const afterRejectedLink = await proofSnapshot(page);
	expect(
		afterRejectedLink.calls.filter(
			(call) =>
				call.method === "POST" && call.path.endsWith("/api/auth/link-social")
		)
	).toEqual([
		{
			method: "POST",
			path: "/api/auth/link-social",
			body: {
				callbackURL: "http://localhost:3001/settings?tab=connections",
				disableRedirect: true,
				provider: "github",
			},
		},
	]);
	expect(
		afterRejectedLink.calls.filter(
			(call) =>
				call.method === "GET" && call.path.endsWith("/api/auth/list-accounts")
		)
	).toHaveLength(1);
	await expect(
		page.getByText(
			/Identity service is unavailable|Failed to link GitHub account/u
		)
	).toBeVisible();
	await expect(githubLink).toBeEnabled();
	await githubLink.click();
	await expect(
		page.getByText("Complete GitHub account linking in your browser", {
			exact: true,
		})
	).toBeVisible();
	let snapshot = await proofSnapshot(page);
	expect(
		snapshot.calls
			.filter(
				(call) =>
					call.method === "POST" && call.path.endsWith("/api/auth/link-social")
			)
			.map((call) => ({ method: call.method, body: call.body }))
	).toEqual([
		{
			method: "POST",
			body: {
				callbackURL: "http://localhost:3001/settings?tab=connections",
				disableRedirect: true,
				provider: "github",
			},
		},
		{
			method: "POST",
			body: {
				callbackURL: "http://localhost:3001/settings?tab=connections",
				disableRedirect: true,
				provider: "github",
			},
		},
	]);
	expect(
		snapshot.tauriCalls.filter((call) => call.command === "open_external")
	).toEqual([
		{
			args: {
				url: "https://identity.fixture.test/authorize?flow=connections-proof",
			},
			command: "open_external",
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("connections-linked-accounts-fixture.png"),
	});

	const unlinkGoogle = hub.getByRole("button", {
		name: "Unlink Google account",
		exact: true,
	});
	await unlinkGoogle.click();
	const unlinkDialog = page.getByRole("alertdialog", {
		name: "Unlink Google account?",
	});
	await expect(unlinkDialog).toBeVisible();
	await unlinkDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(unlinkDialog).not.toBeVisible();
	snapshot = await proofSnapshot(page);
	expect(
		snapshot.calls.filter((call) =>
			call.path.endsWith("/api/auth/unlink-account")
		)
	).toHaveLength(0);
	await expect(unlinkGoogle).toBeVisible();

	await unlinkGoogle.click();
	await armFailure(page, "unlink-account");
	await page
		.getByRole("alertdialog", { name: "Unlink Google account?" })
		.getByRole("button", { name: "Unlink", exact: true })
		.click();
	await expect(
		page.getByText("Account permission check failed", { exact: true })
	).toBeVisible();
	const confirmation = page.getByRole("alertdialog", {
		name: "Unlink Google account?",
	});
	const unlinkAction = confirmation.getByRole("button", {
		name: "Unlink",
		exact: true,
	});
	await expect(confirmation).toBeVisible();
	await expect(unlinkAction).toBeEnabled();
	await expect((await proofSnapshot(page)).accounts).toHaveLength(1);
	await unlinkAction.click();
	await expect(
		hub.getByRole("button", {
			name: "Link Google account",
			exact: true,
		})
	).toBeVisible();
	snapshot = await proofSnapshot(page);
	expect(
		snapshot.calls
			.filter(
				(call) =>
					call.method === "POST" &&
					call.path.endsWith("/api/auth/unlink-account")
			)
			.map((call) => ({ method: call.method, body: call.body }))
	).toEqual([
		{ method: "POST", body: { accountId: "google-account-1" } },
		{ method: "POST", body: { accountId: "google-account-1" } },
	]);
	expect(snapshot.accounts).toEqual([]);
	expect(page.url()).toBe(webviewUrl);
	expect(navigations).toEqual([]);
	await page.reload();
	const reloaded = await revealConnections(page);
	await expect(
		reloaded.hub.getByRole("button", {
			name: "Link Google account",
			exact: true,
		})
	).toBeVisible();
	await expect((await proofSnapshot(page)).accounts).toEqual([]);
	expect(
		(await proofSnapshot(page)).calls.filter(
			(call) =>
				call.method === "GET" && call.path.endsWith("/api/auth/list-accounts")
		).length
	).toBeGreaterThanOrEqual(2);
});
