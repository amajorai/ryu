import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { parseMarketplaceWallpaperSelection } from "@ryuhq/protocol/marketplace-wallpaper";
import { z } from "zod";
import type { ProofJsonValue } from "./fixture-json.ts";

const PROOF_DIR = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/marketplace-wallpaper-banners"
);
const MESH_ID = "com.ryu.marketplace-defaults:mesh-gradient";
const GRID_ID = "com.ryu.marketplace-defaults:dynamic-grid";
const PROFILE_BANNER_KEY = "ryu.profile-banner-wallpaper.v1";

function field<RawInput>(
	value: RawInput,
	key: string
): ProofJsonValue | undefined {
	const parsed = z.record(z.string(), z.json()).safeParse(value);
	return parsed.success ? parsed.data[key] : undefined;
}

function parseJson(value: string | null) {
	if (!value) {
		return undefined;
	}
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

test("node and account wallpaper banners render and persist on their owning scopes", async ({
	page,
}) => {
	await mkdir(PROOF_DIR, { recursive: true });
	await page.setViewportSize({ width: 1600, height: 1150 });
	await page.addInitScript(() => localStorage.clear());

	const nodePreferences = new Map<string, string>();
	let accountBanner: ProofJsonValue | undefined = null;
	const profileBannerWriteOrder: string[] = [];

	await page.route("**/api/preferences/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const encodedKey = url.pathname.split("/").at(-1) ?? "";
		const key = decodeURIComponent(encodedKey);
		if (request.method() === "PUT") {
			const body = parseJson(request.postData());
			const value = field(body, "value");
			if (isNativeText(value)) {
				nodePreferences.set(key, value);
				if (key === PROFILE_BANNER_KEY) {
					profileBannerWriteOrder.push("node");
				}
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
			body: JSON.stringify({ value: nodePreferences.get(key) ?? null }),
		});
	});

	await page.route("**/api/profile/me/profile", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ bannerWallpaper: accountBanner }),
		})
	);
	await page.route("**/api/profile/me/banner-wallpaper", async (route) => {
		const body = parseJson(route.request().postData());
		const selection = field(body, "bannerWallpaper");
		accountBanner =
			selection === null
				? null
				: (parseMarketplaceWallpaperSelection(selection) ?? null);
		profileBannerWriteOrder.push("public-profile");
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ ok: true, bannerWallpaper: accountBanner }),
		});
	});
	await page.route("**/api/profile/public/proof-user", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ profile: { bannerWallpaper: accountBanner } }),
		})
	);
	await page.route("**/api/auth/**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ session: null, user: null }),
		})
	);

	await page.goto("/wallpaper-banner-surfaces-proof.html");
	await expect(page.getByTestId("agent-banner-surface")).toBeVisible();
	await expect(page.getByTestId("space-marketplace-cover")).toBeVisible();
	await expect(page.getByTestId("profile-banner-preview")).toBeVisible();
	await expect(page.getByTestId("public-profile-surface")).toBeVisible();

	const agent = page.getByTestId("agent-banner-surface");
	await agent.getByRole("button", { name: "Customize" }).click();
	await page
		.getByRole("button", { name: "Browse Marketplace wallpapers" })
		.click();
	await expect(page.getByText("260 of 260 wallpapers")).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: path.join(PROOF_DIR, "marketplace-wallpaper-picker.png"),
	});
	await page.getByTestId(`banner-wallpaper-${MESH_ID}`).click();
	await expect(page.getByTestId("agent-banner-selection")).toHaveText(MESH_ID);
	await expect(agent.locator(`[data-backdrop-id="${MESH_ID}"]`)).toBeVisible();
	const agentStored = [...nodePreferences.entries()].find(([key]) =>
		key.startsWith("ryu.agent-banner.v1:")
	);
	expect(agentStored).toBeDefined();
	expect(parseJson(agentStored?.[1] ?? null)).toMatchObject({
		wallpaper: { backdropId: "shader-mesh-gradient", id: MESH_ID },
	});
	await page.getByRole("button", { name: "Done" }).click();

	await page.getByRole("button", { name: "Choose cover" }).click();
	await page.getByTestId(`banner-wallpaper-${GRID_ID}`).click();
	await expect(
		page.locator(
			`[data-testid="space-marketplace-cover"] [data-backdrop-id="${GRID_ID}"]`
		)
	).toBeVisible();
	const spaceStored = [...nodePreferences.entries()].find(([key]) =>
		key.startsWith("ryu.space-cover.v1:")
	);
	expect(spaceStored).toBeDefined();
	expect(parseJson(spaceStored?.[1] ?? null)).toMatchObject({
		backdropId: "shader-dot-grid",
		id: GRID_ID,
	});

	const account = page.getByTestId("account-profile-settings");
	await account
		.getByRole("button", { name: "Choose Marketplace wallpaper" })
		.click();
	await page.getByTestId(`banner-wallpaper-${MESH_ID}`).click();
	await expect(
		page
			.getByTestId("profile-banner-preview")
			.locator(`[data-backdrop-id="${MESH_ID}"]`)
	).toBeVisible();
	await expect(page.getByTestId("public-profile-selection")).toHaveText(
		MESH_ID
	);
	await expect(
		page.getByRole("dialog", { name: "Choose a public profile banner" })
	).toBeHidden();
	expect(accountBanner).toMatchObject({
		backdropId: "shader-mesh-gradient",
		id: MESH_ID,
	});
	expect(
		parseJson(nodePreferences.get(PROFILE_BANNER_KEY) ?? null)
	).toMatchObject({
		backdropId: "shader-mesh-gradient",
		id: MESH_ID,
	});
	expect(profileBannerWriteOrder.slice(-2)).toEqual(["node", "public-profile"]);
	const installedLibrary = parseJson(
		await page.evaluate(() => localStorage.getItem("ryu:wallpaper-library"))
	);
	expect(field(installedLibrary, "ids")).toEqual(
		expect.arrayContaining([MESH_ID, GRID_ID])
	);

	await page.screenshot({
		fullPage: true,
		path: path.join(PROOF_DIR, "all-banner-surfaces.png"),
	});
});

async function profileBannerFixture(page: Page) {
	const nodeWrites: unknown[] = [];
	const accountWrites: { token: string | undefined; selection: unknown }[] = [];
	let nodeBanner = "null";
	let accountBanner: ProofJsonValue | undefined = null;
	let rejectAccount = true;
	let holdNode = false;
	let holdAccount = false;
	let releaseNode: (() => void) | undefined;
	let releaseAccount: (() => void) | undefined;
	await page.addInitScript(() => localStorage.clear());
	await page.route("**/api/preferences/**", async (route) => {
		const key = decodeURIComponent(
			new URL(route.request().url()).pathname.split("/").at(-1) ?? ""
		);
		if (route.request().method() === "PUT") {
			const value = field(parseJson(route.request().postData()), "value");
			if (key === PROFILE_BANNER_KEY && isNativeText(value)) {
				nodeBanner = value;
				nodeWrites.push(parseJson(value));
				if (holdNode) {
					await new Promise<void>((resolve) => {
						releaseNode = resolve;
					});
				}
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: '{"ok":true}',
			});
			return;
		}
		const otherNode = new URL(route.request().url()).port === "7991";
		const value =
			key === PROFILE_BANNER_KEY
				? otherNode
					? JSON.stringify({
							id: GRID_ID,
							backdropId: "shader-dot-grid",
							params: {},
						})
					: nodeBanner
				: null;
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ value }),
		});
	});
	await page.route("**/api/profile/me/profile", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ bannerWallpaper: accountBanner }),
		})
	);
	await page.route("**/api/profile/me/banner-wallpaper", async (route) => {
		const selection = field(
			parseJson(route.request().postData()),
			"bannerWallpaper"
		);
		accountWrites.push({
			token: route.request().headers().authorization,
			selection,
		});
		if (holdAccount) {
			holdAccount = false;
			await new Promise<void>((resolve) => {
				releaseAccount = resolve;
			});
		}
		if (rejectAccount) {
			await route.fulfill({
				status: 503,
				contentType: "application/json",
				body: '{"error":"profile unavailable"}',
			});
			return;
		}
		accountBanner = selection;
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ ok: true, bannerWallpaper: accountBanner }),
		});
	});
	await page.route("**/api/profile/public/proof-user", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ profile: { bannerWallpaper: accountBanner } }),
		})
	);
	await page.route("**/api/auth/**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ session: null, user: null }),
		})
	);
	return {
		nodeWrites,
		accountWrites,
		nodeBanner: () => parseJson(nodeBanner),
		accountBanner: () => accountBanner,
		acceptAccount: () => {
			rejectAccount = false;
		},
		holdNode: () => {
			holdNode = true;
		},
		holdAccount: () => {
			holdAccount = true;
		},
		releaseNode: () => {
			holdNode = false;
			releaseNode?.();
		},
		releaseAccount: () => {
			holdAccount = false;
			releaseAccount?.();
		},
	};
}

async function chooseProfileBanner(page: Page) {
	const account = page.getByTestId("account-profile-settings");
	await account
		.getByRole("button", { name: "Choose Marketplace wallpaper" })
		.click();
	await page.getByTestId(`banner-wallpaper-${MESH_ID}`).click();
}

test("failed public banner write keeps node selection and retries only the account copy", async ({
	page,
}) => {
	const fixture = await profileBannerFixture(page);
	await page.goto("/wallpaper-banner-surfaces-proof.html");
	await chooseProfileBanner(page);
	const dialog = page.getByRole("dialog", {
		name: "Choose a public profile banner",
	});
	await expect(dialog.getByRole("alert")).toHaveText(
		"The wallpaper could not be saved. Try again."
	);
	expect(fixture.nodeBanner()).toMatchObject({ id: MESH_ID });
	expect(fixture.accountBanner()).toBeNull();
	expect(fixture.nodeWrites).toHaveLength(1);
	expect(fixture.accountWrites).toHaveLength(1);
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Escape");
	const account = page.getByTestId("account-profile-settings");
	await expect(
		account.getByText(
			"Saved on this node, but the public profile copy could not be updated. Retry the sync below."
		)
	).toBeVisible();
	await expect(
		page
			.getByTestId("profile-banner-preview")
			.locator(`[data-backdrop-id="${MESH_ID}"]`)
	).toBeVisible();
	await expect(page.getByTestId("public-profile-selection")).toHaveText("none");
	await account
		.getByRole("button", { name: "Retry public profile sync" })
		.click();
	await expect(
		account.getByText(
			"The public profile copy could not be updated. Try again."
		)
	).toBeVisible();
	expect(fixture.nodeWrites).toHaveLength(1);
	fixture.acceptAccount();
	await account
		.getByRole("button", { name: "Retry public profile sync" })
		.click();
	await expect(
		account.getByRole("button", { name: "Retry public profile sync" })
	).toBeHidden();
	await expect(page.getByTestId("public-profile-selection")).toHaveText(
		MESH_ID
	);
	expect(fixture.nodeWrites).toHaveLength(1);
	expect(fixture.accountWrites).toHaveLength(3);
	expect(fixture.accountBanner()).toMatchObject({ id: MESH_ID });
	await page.reload();
	await expect(
		page
			.getByTestId("profile-banner-preview")
			.locator(`[data-backdrop-id="${MESH_ID}"]`)
	).toBeVisible();
	await expect(page.getByTestId("public-profile-selection")).toHaveText(
		MESH_ID
	);
});

test("account change while node save waits cannot publish the prior banner as the new account", async ({
	page,
}) => {
	const fixture = await profileBannerFixture(page);
	fixture.holdNode();
	await page.goto("/wallpaper-banner-surfaces-proof.html");
	await chooseProfileBanner(page);
	await expect.poll(() => fixture.nodeWrites.length).toBe(1);
	await page.evaluate(() => {
		localStorage.setItem("ryu_session_token", "proof-other-account-token");
		localStorage.setItem("ryu_active_user_id", "proof-other-account");
	});
	fixture.releaseNode();
	await expect(page.getByTestId(`banner-wallpaper-${MESH_ID}`)).toBeEnabled();
	expect(
		fixture.accountWrites.filter(
			(write) => write.token === "Bearer proof-other-account-token"
		)
	).toEqual([]);
	await page.keyboard.press("Escape");
	await expect(
		page
			.getByTestId("account-profile-settings")
			.getByRole("button", { name: "Retry public profile sync" })
	).toBeHidden();
});

test("node change while account write waits cannot restore stale banner or error in the new target", async ({
	page,
}) => {
	const fixture = await profileBannerFixture(page);
	fixture.holdAccount();
	await page.goto("/wallpaper-banner-surfaces-proof.html");
	await chooseProfileBanner(page);
	await expect.poll(() => fixture.accountWrites.length).toBe(1);
	const nodeStorePath = fileURLToPath(
		new URL("../src/store/useNodeStore.ts", import.meta.url)
	).replaceAll("\\", "/");
	const nodeStoreUrl = `/@fs/${nodeStorePath.replace(/^\//u, "")}`;
	await page.evaluate(async (moduleUrl) => {
		const { useNodeStore } = await import(moduleUrl);
		const nodes = useNodeStore.getState().nodes;
		useNodeStore.setState({
			nodes: [
				...nodes,
				{
					name: "proof-other-node",
					url: "http://127.0.0.1:7991",
					token: "other-node-token",
					userJwt: null,
				},
			],
			defaultNode: "proof-other-node",
		});
	}, nodeStoreUrl);
	await expect(
		page
			.getByTestId("profile-banner-preview")
			.locator(`[data-backdrop-id="${GRID_ID}"]`)
	).toBeVisible();
	fixture.releaseAccount();
	await expect(page.getByTestId(`banner-wallpaper-${MESH_ID}`)).toBeEnabled();
	await page.keyboard.press("Escape");
	await expect(
		page
			.getByTestId("profile-banner-preview")
			.locator(`[data-backdrop-id="${GRID_ID}"]`)
	).toBeVisible();
	await expect(
		page
			.getByTestId("account-profile-settings")
			.getByText(
				"Saved on this node, but the public profile copy could not be updated. Retry the sync below."
			)
	).toBeHidden();
});

test("public banner retry cannot reuse a previous account's pending selection", async ({
	page,
}) => {
	const fixture = await profileBannerFixture(page);
	await page.goto("/wallpaper-banner-surfaces-proof.html");
	await chooseProfileBanner(page);
	await expect(
		page
			.getByRole("dialog", { name: "Choose a public profile banner" })
			.getByRole("alert")
	).toBeVisible();
	await page.keyboard.press("Escape");
	expect(fixture.accountWrites).toHaveLength(1);
	await page.evaluate(() => {
		localStorage.setItem("ryu_session_token", "proof-other-account-token");
		localStorage.setItem("ryu_active_user_id", "proof-other-account");
	});
	fixture.acceptAccount();
	const account = page.getByTestId("account-profile-settings");
	await account
		.getByRole("button", { name: "Retry public profile sync" })
		.click();
	await expect(
		account.getByText(
			"Your account or node changed. Reload your profile before syncing its banner."
		)
	).toBeVisible();
	expect(fixture.accountWrites).toHaveLength(1);
	expect(fixture.accountBanner()).toBeNull();
});
