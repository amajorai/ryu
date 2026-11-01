import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { parseProofJson } from "./fixture-json.ts";
import {
	chooseOrg,
	EVIDENCE,
	fixture,
	localDefault,
	PROOF_URL,
	toProfile,
} from "./onboarding-setup-page-proof.fixture.ts";

test("production paid connections search, reveal more, require permission, and read back connection", async ({
	page,
}) => {
	const f = await fixture(page, { paid: true });
	try {
		await localDefault(page);
		await chooseOrg(page);
		await expect(
			page.getByRole("button", { name: "Connected", exact: true })
		).toBeDisabled();
		await page.getByRole("button", { name: "More integrations" }).click();
		await page
			.getByPlaceholder("Search Gmail, Notion, Slack, GitHub, or more")
			.fill("Notion");
		await page.getByRole("button", { name: "Connect", exact: true }).click();
		const dialog = page.getByTestId("connection-permission-dialog");
		await expect(dialog).toBeVisible();
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(dialog).not.toBeVisible();
		expect(f.calls.some((c) => c.path.endsWith("/initiate"))).toBe(false);
		await page.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(dialog).toBeVisible();
		expect(f.calls.some((c) => c.path.endsWith("/initiate"))).toBe(false);
		await dialog.getByRole("button", { name: "Continue to connect" }).click();
		await expect(dialog).toBeHidden();
		await expect(
			page.getByRole("button", { name: "Connected", exact: true })
		).toBeDisabled();
		const call = f.calls.find((c) => c.path.endsWith("/initiate"));
		expect(call?.body).toEqual({
			toolkit: "notion",
			access_level: "risk_based",
		});
		expect(call?.authorization).toBe("Bearer setup-proof-node-token");
		expect((await f.read()).connections.at(-1)?.toolkit).toBe("notion");
		await page.screenshot({
			path: path.join(EVIDENCE, "onboarding-production-connected-readback.png"),
			fullPage: true,
		});
	} finally {
		await f.close();
	}
});

test("production profile failure retry materializes background and continues", async ({
	page,
}) => {
	const f = await fixture(page, { paid: true, failedJob: true });
	try {
		await toProfile(page);
		await page.getByRole("button", { name: "Build my profile" }).click();
		await expect(page.getByText("Fixture draft failed")).toBeVisible();
		await page.getByRole("button", { name: "Try again", exact: true }).click();
		await page.getByRole("button", { name: "Run in background" }).click();
		await expect(
			page.getByRole("button", { name: "Continue setup", exact: true })
		).toBeVisible();
		expect((await f.read()).materialized).toBe(true);
		const starts = f.calls.filter((c) => c.path.endsWith("/profile/start"));
		expect(starts).toHaveLength(2);
		expect(starts[0]?.body).toMatchObject({
			recentDays: 90,
			shareUserOrg: false,
			importedConversationIds: [],
			sourceIds: ["gmail-existing"],
		});
		expect(starts[0]?.authorization).toBe("Bearer setup-proof-node-token");
		await page.screenshot({
			path: path.join(
				EVIDENCE,
				"onboarding-production-profile-background-completed.png"
			),
			fullPage: true,
		});
		await page
			.getByRole("button", { name: "Continue setup", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Choose how you talk to Ryu" })
		).toBeVisible();
	} finally {
		await f.close();
	}
});

test("production profile cancel calls exact job and permission denial skips gateway mutations", async ({
	page,
}) => {
	const f = await fixture(page, { paid: true });
	try {
		await toProfile(page);
		await page.getByRole("button", { name: "Build my profile" }).click();
		await page.getByRole("button", { name: "Skip and cancel" }).click();
		await expect(
			page.getByRole("heading", { name: "Choose how you talk to Ryu" })
		).toBeVisible();
		expect((await f.read()).cancelled).toBe(true);
		expect(
			f.calls.some(
				(c) =>
					c.method === "POST" &&
					c.path === "/api/onboarding/profile/cancel/profile-one"
			)
		).toBe(true);
	} finally {
		await f.close();
	}
});

test("production gateway denial advances to the cloud lane without organization or provider mutations", async ({
	page,
}) => {
	const f = await fixture(page, { denied: true });
	try {
		await localDefault(page);
		await expect(
			page.getByRole("button", { name: "Use local for now" })
		).toBeVisible();
		expect(
			f.calls.some(
				(c) =>
					c.path === "/api/pi-config/providers" ||
					c.path === "/api/auth/organization/set-active"
			)
		).toBe(false);
	} finally {
		await f.close();
	}
});

test("production failed connection read suppresses duplicate connects and allows safe continuation", async ({
	page,
}) => {
	const f = await fixture(page, { paid: true, failedConnections: true });
	try {
		await localDefault(page);
		await chooseOrg(page);
		await expect(
			page.getByText(
				"Ryu could not verify your existing connections, so onboarding will not start another one."
			)
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Connect", exact: true })
		).toHaveCount(0);
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Set your cloud default" })
		).toBeVisible();
		expect(f.calls.some((c) => c.path.endsWith("/initiate"))).toBe(false);
	} finally {
		await f.close();
	}
});

test("production local and cloud lane selections persist distinct exact defaults", async ({
	page,
}) => {
	const f = await fixture(page, { paid: true });
	try {
		await page.goto(PROOF_URL);
		await page
			.getByRole("button", {
				name: "Continue with no optional packs",
				exact: true,
			})
			.click();
		await page
			.getByRole("button", { name: "Choose default local agent", exact: true })
			.click();
		await page
			.getByRole("textbox", { name: "Custom model id" })
			.fill(" fixture/local ");
		await page
			.getByRole("button", { name: "Use this model", exact: true })
			.click();
		await page
			.getByRole("button", { name: "Save default", exact: true })
			.click();
		await chooseOrg(page);
		await expect(
			page.getByRole("heading", { name: "Connect your accounts" })
		).toBeVisible();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await page
			.getByRole("button", { name: "Choose default cloud agent", exact: true })
			.click();
		await page
			.getByRole("textbox", { name: "Custom model id" })
			.fill(" fixture/cloud ");
		await page
			.getByRole("button", { name: "Use this model", exact: true })
			.click();
		await page
			.getByRole("button", { name: "Save default", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Import existing threads" })
		).toBeVisible();
		const saved = await f.read();
		const writes = f.calls.filter(
			(c) =>
				c.method === "PUT" &&
				[
					"/api/preferences/default-local-agent-selection",
					"/api/preferences/default-cloud-agent-selection",
				].includes(c.path)
		);
		expect(writes).toHaveLength(2);
		for (const lane of ["local", "cloud"]) {
			expect(
				parseProofJson(saved.preferences[`default-${lane}-agent-selection`])
			).toEqual({
				access_mode: "",
				agent_id: lane === "local" ? "" : "ryu",
				effort: "",
				model: `fixture/${lane}`,
				provider: "",
				thinking_level: "",
			});
		}
		for (const call of writes) {
			expect(call.authorization).toBe("Bearer setup-proof-node-token");
			expect(call.body).toEqual({
				value:
					saved.preferences[
						decodeURIComponent(call.path.split("/").at(-1) ?? "")
					],
			});
		}
	} finally {
		await f.close();
	}
});

test("production setup disables continuation and agent selection until the lane write finishes", async ({
	page,
}) => {
	const f = await fixture(page, { holdLocalWrite: true });
	try {
		await page.goto(PROOF_URL);
		await page
			.getByRole("button", {
				name: "Continue with no optional packs",
				exact: true,
			})
			.click();
		const save = page.getByRole("button", {
			name: "Save default",
			exact: true,
		});
		await save.click();
		await expect
			.poll(
				() =>
					f.calls.filter(
						(c) =>
							c.method === "PUT" &&
							c.path === "/api/preferences/default-local-agent-selection"
					).length
			)
			.toBe(1);
		await expect(page.locator("fieldset")).toHaveAttribute("aria-busy", "true");
		await expect(save).toBeDisabled();
		await expect(
			page.getByRole("button", {
				name: "Choose default local agent",
				exact: true,
			})
		).toBeDisabled();
		expect(
			(await f.read()).preferences["default-local-agent-selection"]
		).toBeUndefined();
		await mkdir(EVIDENCE, { recursive: true });
		await page.screenshot({
			path: path.join(EVIDENCE, "onboarding-production-save-busy.png"),
			fullPage: true,
		});
		f.releaseLocalWrite();
		await expect(
			page.getByRole("heading", { name: "Choose your organization" })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /Team proof/ })
		).toBeEnabled();
		await page.screenshot({
			path: path.join(EVIDENCE, "onboarding-production-save-completed.png"),
			fullPage: true,
		});
		expect(
			f.calls.filter(
				(c) =>
					c.method === "PUT" &&
					c.path === "/api/preferences/default-local-agent-selection"
			)
		).toHaveLength(1);
	} finally {
		await f.close();
	}
});
