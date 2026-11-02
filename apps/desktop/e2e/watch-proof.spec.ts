import { expect, test } from "@playwright/test";
import type { WatchSnapshot } from "../../../packages/protocol/src/watch.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

test("admin monitoring flow and responsive evidence", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const now = new Date().toISOString();
	const snapshot: WatchSnapshot = {
		events: [],
		assets: [
			{
				id: "proof-node",
				enrollmentSource: "managed-cloud",
				name: "Production gateway",
				ownerId: "proof-owner",
				origin: "http://203.0.113.10:7980",
				status: "active",
				lastScanAt: now,
				nextScanAt: now,
				lastError: null,
				notificationStatus: "sent",
				notifiedAt: now,
				checks: [
					{
						id: "transport",
						status: "finding",
						severity: "medium",
						summary:
							"The enrolled origin accepts unencrypted HTTP. Use HTTPS and verify the redirect policy.",
					},
					{
						id: "management-auth",
						status: "finding",
						severity: "medium",
						summary:
							"The management path accepted an unauthenticated HEAD request. Potential exposure; review authentication before changing configuration.",
					},
				],
			},
		],
		leaks: [
			{
				id: "proof-leak",
				credentialId: "gateway-credential",
				status: "open",
				firstSeenAt: now,
				lastSeenAt: now,
				notifiedAt: null,
				notificationStatus: "pending",
			},
		],
		reports: [
			{
				id: "proof-analysis",
				project: "ryu",
				source: "repository",
				subjectId: "ryu",
				revision: "a".repeat(40),
				observedAt: now,
				checks: [
					{ id: "secrets", status: "pass", findings: 0 },
					{ id: "static-analysis", status: "finding", findings: 2 },
					{ id: "dependencies", status: "finding", findings: 4 },
				],
				issues: [
					{
						checkId: "static-analysis",
						ruleId: "ryu-tls-verification-disabled",
						path: "src/example.ts",
						line: 42,
					},
				],
			},
		],
		nextCursor: null,
		nextLeakCursor: null,
		service: {
			workerEnabled: true,
			partnerIntakeEnabled: false,
			lastWorkerAt: now,
			lastPartnerAt: null,
			workerError: null,
		},
	};
	await page.route("**/api/watch**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (request.method() === "POST" && url.pathname === "/api/watch/assets") {
			const body = request.postDataJSON();
			expect(body.consent).toBe(true);
			snapshot.assets.push({
				...snapshot.assets[0]!,
				id: "new-node",
				enrollmentSource: "dns",
				name: body.name,
				origin: body.origin,
				status: "pending",
				checks: [],
				lastScanAt: null,
				notifiedAt: null,
				notificationStatus: "pending",
			});
			await route.fulfill({
				json: {
					asset: snapshot.assets[1],
					dns: {
						name: "_ryu-watch.staging.example.com",
						type: "TXT",
						value: "ryu-watch=synthetic-proof-challenge",
					},
				},
			});
			return;
		}
		if (url.pathname.endsWith("/pause")) {
			snapshot.assets[0]!.status = "paused";
			await route.fulfill({ json: { asset: snapshot.assets[0] } });
			return;
		}
		await route.fulfill({ json: snapshot });
	});
	await page.goto("/watch-proof.html");
	await expect(
		page.getByRole("link", { name: "GitHub enrollment instructions" })
	).toHaveAttribute(
		"href",
		/^https:\/\/docs.github.com\/en\/code-security\/tutorials\/secret-scanning-partner-program/
	);
	await expect(
		page.getByText("Auto-enrolled cloud", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Ryu Watch", exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Production gateway", { exact: true })
	).toBeVisible();
	await expect(page.getByText("Not checked", { exact: true })).toHaveCount(2);
	await expect(
		page.getByRole("link", { name: "Prepare repair in Ryu" })
	).toHaveAttribute("href", /^ryu:\/\/chat\/new\?prompt=/);
	await page
		.getByRole("textbox", { name: "Private name" })
		.fill("Staging gateway");
	await page
		.getByRole("textbox", { name: "Domain origin" })
		.fill("https://staging.example.com");
	await page.getByRole("checkbox").check();
	await page.getByRole("button", { name: "Enroll and get DNS record" }).click();
	await expect(
		page.getByText("_ryu-watch.staging.example.com", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Staging gateway", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Pause monitoring" }).click();
	await expect(
		page.getByText("Monitoring paused.", { exact: true })
	).toBeVisible();
	await page.getByText("Review finding locations (1 shown)").click();
	await expect(
		page.getByText("src/example.ts:42", { exact: true })
	).toBeVisible();
	const proof = proofEvidencePath("ryu-watch/cloud-auto-enrollment");
	await page.screenshot({ path: `${proof}/admin-desktop.png`, fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(
		page.getByRole("button", { name: "Refresh", exact: true })
	).toBeVisible();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth
		)
	).toBe(true);
	await page.screenshot({ path: `${proof}/admin-mobile.png`, fullPage: true });
	await page.evaluate(() => document.documentElement.classList.add("dark"));
	await page.screenshot({
		path: `${proof}/admin-dark-mobile.png`,
		fullPage: true,
		animations: "disabled",
	});
	expect(errors).toEqual([]);
});
