import { expect, test } from "@playwright/test";
import type { MarketplaceCreatorProfileFields } from "@ryu/marketplace/creators/types";
import { normalizeCreatorProfileInput } from "../../../packages/api/src/lib/marketplace-creators.ts";

for (const surface of ["desktop", "web"]) {
	test(`${surface} production creator host preserves refused drafts and reloads acknowledged fields`, async ({
		page,
	}, testInfo) => {
		let saved: MarketplaceCreatorProfileFields = {
			bio: "Original bio",
			website: null,
			githubHandle: null,
			xHandle: null,
		};
		let refusal = 403;
		const writes: unknown[] = [];
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		if (surface === "web") {
			await page.context().addCookies([
				{
					name: "creator-proof-session",
					value: "fixture-cookie",
					url: "http://localhost:5197",
				},
			]);
		}
		await page.route("**/api/marketplace/creator-profile", async (route) => {
			const request = route.request();
			if (surface === "desktop") {
				expect(request.headers().authorization).toBe("Bearer fixture-bearer");
			}
			if (surface === "web") {
				expect(request.headers().cookie).toContain(
					"creator-proof-session=fixture-cookie"
				);
			}
			if (request.method() === "GET") {
				return route.fulfill({
					json: {
						organizationId: "org-a",
						name: "Creator A",
						slug: "creator-a",
						profile: saved,
					},
				});
			}
			expect(request.method()).toBe("PUT");
			expect(request.headers()["content-type"]).toBe("application/json");
			const body = request.postDataJSON();
			writes.push(body);
			if (refusal) {
				return route.fulfill({
					status: refusal,
					json: {
						error:
							refusal === 403
								? "Publishing permission required"
								: "Profile service unavailable",
					},
				});
			}
			const normalized = normalizeCreatorProfileInput(body);
			expect(normalized.ok).toBe(true);
			if (!normalized.ok) {
				throw new Error(normalized.error);
			}
			saved = normalized.value;
			return route.fulfill({
				json: { organizationId: "org-a", profile: saved },
			});
		});
		await page.goto(`/creator-profile-host-proof.html?surface=${surface}`);
		await expect(page.getByLabel("Bio", { exact: true })).toHaveValue(
			"Original bio"
		);
		const draft = {
			bio: "Exact retained draft",
			website: "https://creator.example",
			githubHandle: "creator-git",
			xHandle: "@creator",
		};
		await page.getByLabel("Bio", { exact: true }).fill(draft.bio);
		await page.getByLabel("Website", { exact: true }).fill(draft.website);
		await page.getByLabel("GitHub", { exact: true }).fill(draft.githubHandle);
		await page.getByLabel("X", { exact: true }).fill(draft.xHandle);
		await page.getByRole("button", { name: "Save profile" }).click();
		await expect(
			page.getByText("Publishing permission required", { exact: true })
		).toBeVisible();
		await expect(page.getByLabel("Bio", { exact: true })).toHaveValue(
			draft.bio
		);
		expect(saved.bio).toBe("Original bio");
		refusal = 500;
		await page.getByRole("button", { name: "Save profile" }).click();
		await expect(
			page.getByText("Profile service unavailable", { exact: true })
		).toBeVisible();
		for (const [label, field] of [
			["Bio", "bio"],
			["Website", "website"],
			["GitHub", "githubHandle"],
			["X", "xHandle"],
		] as const) {
			await expect(page.getByLabel(label, { exact: true })).toHaveValue(
				draft[field]
			);
		}
		refusal = 0;
		await page.getByRole("button", { name: "Save profile" }).click();
		const normalizedDraft = normalizeCreatorProfileInput(draft);
		expect(normalizedDraft.ok).toBe(true);
		if (!normalizedDraft.ok) {
			throw new Error(normalizedDraft.error);
		}
		await expect.poll(() => saved).toEqual(normalizedDraft.value);
		expect(writes).toHaveLength(3);
		for (const write of writes) {
			expect(write).toMatchObject({ ...draft, organizationId: "org-a" });
		}
		await page.reload();
		for (const [label, field] of [
			["Bio", "bio"],
			["Website", "website"],
			["GitHub", "githubHandle"],
			["X", "xHandle"],
		] as const) {
			await expect(page.getByLabel(label, { exact: true })).toHaveValue(
				normalizedDraft.value[field] ?? ""
			);
		}
		expect(errors).toEqual([]);
		await page.screenshot({
			path: testInfo.outputPath(`${surface}-creator-profile-saved.png`),
			fullPage: true,
		});
	});
	test(`${surface} production creator host exposes GET refusal`, async ({
		page,
	}) => {
		let failure = 403;
		await page.route("**/api/marketplace/creator-profile", (route) =>
			failure
				? route.fulfill({
						status: failure,
						json: {
							error:
								failure === 403
									? "Creator profile access denied"
									: "Creator profile temporarily unavailable",
						},
					})
				: route.fulfill({
						json: {
							organizationId: "org-a",
							name: "Creator A",
							slug: "creator-a",
							profile: {
								bio: "Recovered profile",
								website: null,
								githubHandle: null,
								xHandle: null,
							},
						},
					})
		);
		await page.goto(`/creator-profile-host-proof.html?surface=${surface}`);
		await expect(
			page.getByText("Creator profile access denied", { exact: true })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Save profile" })
		).toHaveCount(0);
		failure = 500;
		await page.getByRole("button", { name: "Reload profile" }).click();
		await expect(
			page.getByText("Creator profile temporarily unavailable", { exact: true })
		).toBeVisible();
		failure = 0;
		await page.getByRole("button", { name: "Reload profile" }).click();
		await expect(page.getByLabel("Bio", { exact: true })).toHaveValue(
			"Recovered profile"
		);
	});
	test(`${surface} old organization draft cannot reach replacement organization`, async ({
		page,
	}, testInfo) => {
		let activeOrg = "org-a";
		let permissionDenied = false;
		let race = false;
		const writes: unknown[] = [];
		await page.route("**/api/marketplace/creator-profile", async (route) => {
			const request = route.request();
			if (request.method() === "GET") {
				if (permissionDenied) {
					return route.fulfill({
						status: 403,
						json: { error: "Organization membership revoked" },
					});
				}
				return route.fulfill({
					json: {
						organizationId: activeOrg,
						name: activeOrg === "org-a" ? "Creator A" : "Creator B",
						slug: activeOrg,
						profile: {
							bio: activeOrg === "org-a" ? "A original" : "B original",
							website: null,
							githubHandle: null,
							xHandle: null,
						},
					},
				});
			}
			const body = request.postDataJSON();
			writes.push(body);
			if (race) {
				activeOrg = "org-b";
			}
			if (body.organizationId !== activeOrg) {
				return route.fulfill({
					status: 409,
					json: {
						error:
							"The active organization changed. Reload your creator profile before saving.",
						code: "creator_profile_organization_changed",
					},
				});
			}
			return route.fulfill({
				json: { organizationId: activeOrg, profile: body },
			});
		});
		await page.goto(`/creator-profile-host-proof.html?surface=${surface}`);
		await page.getByLabel("Bio", { exact: true }).fill("Private A draft");
		permissionDenied = true;
		await page.getByRole("button", { name: "Save profile" }).click();
		await expect(
			page.getByText("Organization membership revoked", { exact: true })
		).toBeVisible();
		await expect(page.getByLabel("Bio", { exact: true })).toHaveValue(
			"Private A draft"
		);
		expect(writes).toEqual([]);
		permissionDenied = false;
		activeOrg = "org-b";
		await page.getByRole("button", { name: "Save profile" }).click();
		await expect(
			page.getByRole("button", { name: "Reload profile" })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Save profile" })
		).toHaveCount(0);
		expect(writes).toEqual([]);
		await page.getByRole("button", { name: "Reload profile" }).click();
		await expect(page.getByLabel("Bio", { exact: true })).toHaveValue(
			"B original"
		);
		// Session scope changing after the preflight is rejected by canonical PUT.
		activeOrg = "org-a";
		await page.reload();
		await page.getByLabel("Bio", { exact: true }).fill("A racing draft");
		race = true;
		await page.getByRole("button", { name: "Save profile" }).click();
		await expect(
			page.getByText(
				"The active organization changed. Reload your creator profile before saving.",
				{ exact: true }
			)
		).toBeVisible();
		expect(writes).toEqual([
			expect.objectContaining({
				bio: "A racing draft",
				organizationId: "org-a",
			}),
		]);
		await expect(page.getByLabel("Bio", { exact: true })).toHaveValue(
			"A racing draft"
		);
		await expect(
			page.getByRole("button", { name: "Reload profile" })
		).toBeVisible();
		await page.screenshot({
			path: testInfo.outputPath(`${surface}-creator-profile-scope-refused.png`),
			fullPage: true,
		});
		await page.getByRole("button", { name: "Reload profile" }).click();
		await expect(page.getByLabel("Bio", { exact: true })).toHaveValue(
			"B original"
		);
		expect(writes).toHaveLength(1);
		await expect(page.getByText("A racing draft", { exact: true })).toHaveCount(
			0
		);
		await page.screenshot({
			path: testInfo.outputPath(
				`${surface}-creator-profile-scope-reloaded.png`
			),
			fullPage: true,
		});
	});

	test(`${surface} pending preflight and PUT lock the captured draft and prevent duplicate writes`, async ({
		page,
	}, testInfo) => {
		let releasePreflight!: () => void;
		let releaseWrite!: () => void;
		const preflightGate = new Promise<void>((resolve) => {
			releasePreflight = resolve;
		});
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		let reads = 0;
		const writes: unknown[] = [];
		let persisted: MarketplaceCreatorProfileFields = {
			bio: "Original",
			website: null,
			githubHandle: null,
			xHandle: null,
		};
		await page.route("**/api/marketplace/creator-profile", async (route) => {
			if (route.request().method() === "GET") {
				reads += 1;
				if (reads === 2) {
					await preflightGate;
				}
				return route.fulfill({
					json: {
						organizationId: "org-a",
						name: "Creator A",
						slug: "creator-a",
						profile: persisted,
					},
				});
			}
			const body = route.request().postDataJSON();
			writes.push(body);
			await writeGate;
			const normalized = normalizeCreatorProfileInput(body);
			if (!normalized.ok) {
				throw new Error(normalized.error);
			}
			persisted = normalized.value;
			return route.fulfill({
				json: { organizationId: "org-a", profile: persisted },
			});
		});
		try {
			await page.goto(`/creator-profile-host-proof.html?surface=${surface}`);
			await page
				.getByLabel("Bio", { exact: true })
				.fill("Captured pending draft");
			await page
				.getByLabel("Website", { exact: true })
				.fill("https://pending.example");
			await page.getByLabel("GitHub", { exact: true }).fill("pending-git");
			await page.getByLabel("X", { exact: true }).fill("@pending");
			await page.getByRole("button", { name: "Save profile" }).click();
			await expect.poll(() => reads).toBe(2);
			for (const label of ["Bio", "Website", "GitHub", "X"]) {
				await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
			}
			await expect(
				page.getByRole("button", { name: "Save profile" })
			).toBeDisabled();
			expect(writes).toHaveLength(0);
			// Exercise the handler's pending guard independently of disabled buttons.
			await page.locator("form").evaluate((form) => {
				if (!(form instanceof HTMLFormElement)) {
					throw new Error("Expected proof element to be an HTMLFormElement.");
				}
				return form.requestSubmit();
			});
			releasePreflight();
			await expect.poll(() => writes.length).toBe(1);
			for (const label of ["Bio", "Website", "GitHub", "X"]) {
				await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
			}
			expect(writes).toEqual([
				{
					organizationId: "org-a",
					bio: "Captured pending draft",
					website: "https://pending.example",
					githubHandle: "pending-git",
					xHandle: "@pending",
				},
			]);
			await page.locator("form").evaluate((form) => {
				if (!(form instanceof HTMLFormElement)) {
					throw new Error("Expected proof element to be an HTMLFormElement.");
				}
				return form.requestSubmit();
			});
			releaseWrite();
			await expect(page.getByLabel("Bio", { exact: true })).toBeEnabled();
			expect(writes).toHaveLength(1);
			expect(reads).toBe(2);
			await page.reload();
			await expect(page.getByLabel("Bio", { exact: true })).toHaveValue(
				"Captured pending draft"
			);
			await expect(page.getByLabel("Website", { exact: true })).toHaveValue(
				"https://pending.example/"
			);
			await expect(page.getByLabel("GitHub", { exact: true })).toHaveValue(
				"pending-git"
			);
			await expect(page.getByLabel("X", { exact: true })).toHaveValue(
				"pending"
			);
			expect(writes).toHaveLength(1);
			await page.screenshot({
				path: testInfo.outputPath(
					`${surface}-creator-profile-pending-save-readback.png`
				),
				fullPage: true,
			});
		} finally {
			releasePreflight();
			releaseWrite();
		}
	});
}
