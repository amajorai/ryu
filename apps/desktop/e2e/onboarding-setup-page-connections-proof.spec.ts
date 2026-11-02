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
} from "./onboarding-setup-page-proof.fixture.ts";

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
		// A paid plan goes from the organization straight to the cloud default
		// (4f7563c79d); connections are no longer an onboarding step.
		await chooseOrg(page);
		await expect(
			page.getByRole("heading", { name: "Set your cloud default" })
		).toBeVisible();
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
			page.getByRole("heading", { name: "A few things to know" })
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
