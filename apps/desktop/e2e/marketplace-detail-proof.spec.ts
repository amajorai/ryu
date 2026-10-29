import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import { z } from "zod";
import type { Review } from "@/src/lib/api/marketplace.ts";
import {
	answerDesktopSecretSlot,
	answerEmptyLegacyAuthStore,
	LEGACY_VAULT_LOCAL_STORAGE_KEYS,
	memorySlotStorage,
	readAuthVaultSlot,
	type SlotStorage,
} from "./harness/desktop-secret-slots.ts";

const listingId = "fixture-review-kit";
const buyerId = "fixture-review-buyer";
const time = "2026-10-02T00:00:00.000Z";
interface RequestLog {
	authorization: string | undefined;
	body: unknown;
	method: string;
	path: string;
	status: number;
}

async function install(
	page: Page,
	options: {
		signedOut?: boolean;
		minimal?: boolean;
		ownReview?: boolean;
		accountLifetime?: boolean;
	} = {}
) {
	await page.addInitScript(
		({ signedIn, accountLifetime }) => {
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: {
					writeText: async (text: string) => {
						Object.assign(window, { __marketplaceProofClipboard: text });
					},
				},
			});
			// The account-lifetime proof migrates this plaintext vault into the
			// sealed slot on first load (which purges it), so seed it only once per
			// tab rather than whenever the plaintext keys are absent.
			const seededKey = "marketplace-detail-proof:vault-seeded";
			if (signedIn && !(accountLifetime && sessionStorage.getItem(seededKey))) {
				sessionStorage.setItem(seededKey, "true");
				localStorage.setItem(
					"ryu_session_token",
					"marketplace-detail-session-token"
				);
				localStorage.setItem(
					"ryu_accounts",
					JSON.stringify([
						{
							token: "marketplace-detail-session-token",
							userId: "fixture-review-buyer",
							email: "buyer@example.invalid",
							name: "Review buyer",
							image: null,
						},
						...(accountLifetime
							? [
									{
										token: "marketplace-detail-second-token",
										userId: "fixture-review-second-buyer",
										email: "second@example.invalid",
										name: "Second review buyer",
										image: null,
									},
								]
							: []),
					])
				);
				localStorage.setItem("ryu_active_user_id", "fixture-review-buyer");
			}
		},
		{ signedIn: !options.signedOut, accountLifetime: options.accountLifetime }
	);
	const review = (index: number): Review => ({
		id: `review_${index}`,
		userId: `user_${index}`,
		userName: `Reviewer ${index}`,
		userImage: null,
		title: `Fixture review ${index}`,
		body: `Review body ${index}`,
		rating: 4,
		verifiedPurchase: false,
		createdAt: time,
		updatedAt: time,
	});
	let reviews = Array.from({ length: 22 }, (_, index) => review(index + 1));
	if (options.ownReview) {
		reviews.unshift({
			...review(0),
			id: "my_review",
			userId: buyerId,
			userName: "Review buyer",
			title: "Existing review",
			body: "Existing body",
		});
	}
	const requests: RequestLog[] = [];
	const failures = new Map<string, { status: number; body: unknown }>();
	const installed = new Set<string>();
	await page.context().route("**/__proof/links/**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "text/html",
			body: "<title>Fixture destination</title><p>Public fixture destination</p>",
		})
	);
	await page.route("**/__proof/screens/**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "image/svg+xml",
			body: '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="160"><rect width="280" height="160" fill="#315a83"/><text x="20" y="80" fill="white">Listing preview</text></svg>',
		})
	);
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const pathname = url.pathname;
		if (!pathname.startsWith("/api/")) {
			await route.continue();
			return;
		}
		const requestPath = pathname + url.search;
		const method = request.method();
		const body = request.postData() ? request.postDataJSON() : null;
		const key = `${method} ${requestPath}`;
		const reply = async <FixturePayload>(
			status: number,
			payload: FixturePayload
		) => {
			requests.push({
				body,
				method,
				path: requestPath,
				authorization: request.headers().authorization,
				status,
			});
			await route.fulfill({
				status,
				contentType: "application/json",
				body: status === 204 ? undefined : JSON.stringify(payload),
			});
		};
		const failure = failures.get(key) ?? failures.get(`${method} ${pathname}`);
		if (failure) {
			failures.delete(key);
			failures.delete(`${method} ${pathname}`);
			await reply(failure.status, failure.body);
			return;
		}
		if (pathname === "/api/auth/get-session") {
			await reply(
				200,
				options.signedOut
					? null
					: {
							session: {
								id: "fixture-session",
								token: "marketplace-detail-session-token",
								userId: buyerId,
								expiresAt: "2030-01-01T00:00:00.000Z",
								createdAt: time,
								updatedAt: time,
							},
							user: {
								id: buyerId,
								name: "Review buyer",
								email: "buyer@example.invalid",
								emailVerified: true,
								createdAt: time,
								updatedAt: time,
								image: null,
							},
						}
			);
			return;
		}
		if (pathname === "/api/billing/trial") {
			await reply(200, { firstLaunchAt: Date.now() });
			return;
		}
		if (pathname === "/api/marketplace/catalog") {
			await reply(200, {
				items:
					url.searchParams.get("kind") === "bundle"
						? [
								{
									// The control plane always serializes these card fields, and
									// Desktop's catalog contract rejects a listing without them.
									author: "Fixture publisher",
									category: "Productivity",
									firstParty: false,
									iconUrl: null,
									installSource: null,
									ratingAverage: 0,
									ratingCount: 0,
									id: listingId,
									kind: "bundle",
									name: "Harbor Review Kit",
									version: "1.0.0",
									description:
										"A listing proof with review and bundle actions.",
									pricing: null,
									requirements: {},
									scopes: [],
									targets: [],
									bundleMemberCount: 1,
								},
							]
						: [],
			});
			return;
		}
		if (pathname === "/api/marketplace/catalog/detail") {
			await reply(200, {
				id: listingId,
				kind: "bundle",
				name: "Harbor Review Kit",
				description: "A listing proof with review and bundle actions.",
				...(options.minimal
					? undefined
					: {
							version: "1.0.0",
							developer: "Fixture publisher",
							category: "Productivity",
							website: `${url.origin}/__proof/links/site`,
							privacyPolicyUrl: `${url.origin}/__proof/links/privacy`,
							termsOfServiceUrl: `${url.origin}/__proof/links/terms`,
							screenshots: [
								`${url.origin}/__proof/screens/one.png`,
								`${url.origin}/__proof/screens/two.png`,
							],
							setup: [
								{
									title: "Connect your workspace",
									description: "A public fixture setup step.",
									actionLabel: "Configure workspace",
									actionUrl: `${url.origin}/__proof/links/setup`,
								},
							],
							runnables: [
								{
									id: "fixture-reader",
									kind: "skill",
									name: "Read workspace",
									description: "A read-only listing projection.",
									enabled: true,
								},
							],
							capabilities: ["Read files"],
							examplePrompts: ["Summarize the selected workspace"],
							bundleSourceUrl: `${url.origin}/__proof/links/topic`,
							bundleMembers: [
								{
									id: "com.example.review-kit",
									kind: "plugin",
									name: "Review kit tool",
									required: true,
								},
							],
						}),
			});
			return;
		}
		if (pathname === "/api/marketplace/reviews") {
			if (method === "GET") {
				const offset = Number(url.searchParams.get("cursor") ?? 0);
				const limit = Number(url.searchParams.get("limit") ?? 20);
				await reply(200, {
					reviews: reviews.slice(offset, offset + limit),
					nextCursor:
						offset + limit < reviews.length ? String(offset + limit) : null,
					ratingAverage: 4,
					ratingCount: reviews.length,
				});
				return;
			}
			if (method === "POST") {
				const input = z
					.object({
						rating: z.number(),
						title: z.string().optional(),
						body: z.string().optional(),
					})
					.parse(body);
				reviews = [
					{
						id: "my_review",
						userId: buyerId,
						userName: "Review buyer",
						userImage: null,
						title: input.title ?? null,
						body: input.body ?? null,
						rating: input.rating,
						verifiedPurchase: true,
						createdAt: time,
						updatedAt: time,
					},
					...reviews.filter((item) => item.userId !== buyerId),
				];
				await reply(200, {
					ok: true,
					ratingAverage: input.rating,
					ratingCount: reviews.length,
					verifiedPurchase: true,
				});
				return;
			}
			if (method === "DELETE") {
				reviews = reviews.filter((item) => item.userId !== buyerId);
				await reply(204, null);
				return;
			}
		}
		if (pathname === "/api/plugins/catalog/install" && method === "POST") {
			const input = z.object({ id: z.string() }).parse(body);
			if (installed.has(input.id)) {
				await reply(409, {
					error: "already_installed",
					message: "Already installed",
				});
				return;
			}
			installed.add(input.id);
			await reply(200, { installed: true });
			return;
		}
		if (pathname === "/api/plugins" && method === "GET") {
			await reply(200, {
				plugins: [...installed].map((id) => ({ id, installed: true })),
			});
			return;
		}
		if (pathname === "/api/marketplace/packages/installed") {
			await reply(200, { packages: [] });
			return;
		}
		if (pathname === "/api/marketplace/usage" && method === "POST") {
			await reply(200, { ok: true });
			return;
		}
		if (pathname.startsWith("/api/auth/")) {
			await reply(200, null);
			return;
		}
		await reply(404, { error: `Unexpected proof request ${key}` });
	});
	return {
		requests,
		readReviews: () => structuredClone(reviews),
		installed,
		fail: (
			method: string,
			requestPath: string,
			status = 503,
			body: { error?: string; message: string; requiresPurchase?: boolean } = {
				error: "Temporary listing request failure",
				message: "Temporary listing request failure",
			}
		) => failures.set(`${method} ${requestPath}`, { status, body }),
	};
}

async function open(page: Page, query = "") {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto(`/marketplace-detail-proof.html${query}`);
	await expect
		.poll(
			async () => ({
				pageErrors,
				found: await page
					.getByText("Harbor Review Kit", { exact: true })
					.count(),
			}),
			{ timeout: 15_000 }
		)
		.toEqual({ pageErrors: [], found: 1 });
	await page.getByText("Harbor Review Kit", { exact: true }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Harbor Review Kit", exact: true }).last()
	).toBeVisible();
}
async function more(page: Page) {
	await page.getByRole("button", { name: "More details", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Reviews", exact: true })
	).toBeVisible();
}

/** Keep the request's account fixed across a real AccountList switch/reload.
 * Only these two control-plane endpoints are intercepted by this fixture. */
async function accountReviewTransport(page: Page, held: "read" | "save") {
	const secondId = "fixture-review-second-buyer";
	const accountByBearer = new Map([
		["Bearer marketplace-detail-session-token", buyerId],
		["Bearer marketplace-detail-second-token", secondId],
	]);
	const requests: RequestLog[] = [];
	let denySecondRead = true;
	let denySecondWrite = true;
	let heldRoute: Route | undefined;
	let heldPayload: unknown;
	let reviews: Review[] =
		held === "read"
			? [
					{
						id: "account-a-review",
						userId: buyerId,
						userName: "Review buyer",
						userImage: null,
						title: "Account A persisted review",
						body: "Account A private draft must not become B's draft",
						rating: 4,
						verifiedPurchase: true,
						createdAt: time,
						updatedAt: time,
					},
				]
			: [];
	const pageBody = () => ({
		reviews: structuredClone(reviews),
		nextCursor: null,
		ratingAverage: reviews.length ? 4 : 0,
		ratingCount: reviews.length,
	});
	await page.route("**/api/auth/get-session**", async (route) => {
		const request = route.request();
		expect(request.method()).toBe("GET");
		const url = new URL(request.url());
		expect(url.origin).toBe("http://127.0.0.1:5336");
		expect(url.pathname).toBe("/api/auth/get-session");
		expect(request.postData()).toBeNull();
		const userId = accountByBearer.get(request.headers().authorization);
		expect(userId).toBeDefined();
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				session: {
					id: `session-${userId}`,
					token: request.headers().authorization.slice("Bearer ".length),
					userId,
					expiresAt: "2030-01-01T00:00:00.000Z",
					createdAt: time,
					updatedAt: time,
				},
				user: {
					id: userId,
					name: userId === buyerId ? "Review buyer" : "Second review buyer",
					email:
						userId === buyerId
							? "buyer@example.invalid"
							: "second@example.invalid",
					emailVerified: true,
					createdAt: time,
					updatedAt: time,
					image: null,
				},
			}),
		});
	});
	await page.route("**/api/marketplace/reviews**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		expect(url.origin).toBe("http://127.0.0.1:5336");
		const authorization = request.headers().authorization;
		const userId = accountByBearer.get(authorization);
		expect(userId).toBeDefined();
		expect(url.pathname).toBe("/api/marketplace/reviews");
		const method = request.method();
		const body: unknown = request.postData() ? request.postDataJSON() : null;
		const log: RequestLog = {
			authorization,
			body,
			method,
			path: url.pathname + url.search,
			status: 200,
		};
		requests.push(log);
		let payload;
		if (method === "GET") {
			expect([...url.searchParams.entries()]).toEqual([
				["kind", "bundle"],
				["id", listingId],
				["limit", "20"],
			]);
			expect(body).toBeNull();
			if (userId === secondId && denySecondRead) {
				denySecondRead = false;
				log.status = 403;
				payload = {
					error: "second_account_read_denied",
					message: "Second account review read denied",
				};
			} else {
				payload = pageBody();
			}
		} else {
			expect(method).toBe("POST");
			expect(url.search).toBe("");
			expect(request.headers()["content-type"]).toContain("application/json");
			const expected =
				userId === buyerId
					? {
							kind: "bundle",
							id: listingId,
							rating: 4,
							title: "Account A held save",
							body: "Account A saved body",
						}
					: {
							kind: "bundle",
							id: listingId,
							rating: 5,
							title: "Account B current review",
							body: "Account B current body",
						};
			expect(body).toEqual(expected);
			if (userId === secondId && denySecondWrite) {
				denySecondWrite = false;
				log.status = 403;
				payload = {
					error: "review_locked",
					message: "Second account review write denied",
				};
			} else {
				reviews = [
					{
						id: `review-${userId}`,
						userId: userId ?? "",
						userName:
							userId === buyerId ? "Review buyer" : "Second review buyer",
						userImage: null,
						title: expected.title,
						body: expected.body,
						rating: expected.rating,
						verifiedPurchase: true,
						createdAt: time,
						updatedAt: time,
					},
					...reviews.filter((review) => review.userId !== userId),
				];
				payload = {
					ok: true,
					ratingAverage: expected.rating,
					ratingCount: reviews.length,
					verifiedPurchase: true,
				};
			}
		}
		if (userId === buyerId && method === (held === "read" ? "GET" : "POST")) {
			expect(heldRoute).toBeUndefined();
			heldRoute = route;
			heldPayload = payload;
			return;
		}
		await route.fulfill({
			status: log.status,
			contentType: "application/json",
			body: JSON.stringify(payload),
		});
	});
	return {
		requests,
		isHeld: () => Boolean(heldRoute),
		readReviews: () => structuredClone(reviews),
		release: async () => {
			if (!heldRoute) {
				throw new Error("Expected an account A request before release");
			}
			// A real window reload may cancel the request before its delayed reply.
			// Keep A's accepted write persisted independently of that cancellation.
			if (!heldRoute.request().failure()) {
				await heldRoute.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify(heldPayload),
				});
			}
		},
	};
}

/**
 * The desktop's sealed `auth-vault` slot for a proof that switches accounts:
 * without a native slot the auth client keeps a switch in memory only, so it
 * cannot survive the reload the switch triggers. The slot record lives on the
 * Node side, so it survives every reload of the page. The bridge answers only
 * the slot commands, their change event and the (empty) legacy `auth.bin`
 * store; any other native call is refused as a missing desktop command.
 */
async function installNativeVaultBridge(page: Page): Promise<SlotStorage> {
	const slots = memorySlotStorage();
	await page.exposeBinding(
		"marketplaceDetailNative",
		(_source, command: string, args?: Record<string, unknown>) => {
			const slot = answerDesktopSecretSlot(slots, command, args ?? {});
			if (slot.handled) {
				return slot;
			}
			return answerEmptyLegacyAuthStore(command, args ?? {});
		}
	);
	await page.addInitScript(() => {
		const native = (
			window as unknown as {
				marketplaceDetailNative: (
					command: string,
					args?: Record<string, unknown>
				) => Promise<{ handled: boolean; value: unknown }>;
			}
		).marketplaceDetailNative;
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: {
				invoke: async (command: string, args?: Record<string, unknown>) => {
					const answer = await native(command, args);
					if (!answer.handled) {
						throw new Error(`Unhandled native command: ${command}`);
					}
					return answer.value;
				},
				transformCallback: () => 0,
				unregisterCallback: () => undefined,
			},
		});
	});
	return slots;
}

async function plaintextVault(page: Page): Promise<Array<string | null>> {
	return await page.evaluate(
		(keys) => keys.map((key) => localStorage.getItem(key)),
		[...LEGACY_VAULT_LOCAL_STORAGE_KEYS]
	);
}

for (const held of ["read", "save"] as const) {
	test(`review account switch reload fences held A ${held} and B retries with exact identity`, async ({
		page,
	}, testInfo) => {
		await install(page, { accountLifetime: true });
		const slots = await installNativeVaultBridge(page);
		const fixture = await accountReviewTransport(page, held);
		await open(page, "?account-lifetime");
		// The seeded plaintext vault migrated into the sealed slot.
		await expect
			.poll(() => readAuthVaultSlot(slots))
			.toMatchObject({
				activeUserId: buyerId,
				activeToken: "marketplace-detail-session-token",
			});
		await expect.poll(() => plaintextVault(page)).toEqual([null, null, null]);
		await more(page);
		if (held === "save") {
			await page.getByRole("button", { name: "4 stars", exact: true }).click();
			await page
				.getByRole("textbox", { name: "Review title" })
				.fill("Account A held save");
			await page
				.getByRole("textbox", { name: "Review body" })
				.fill("Account A saved body");
			await page
				.getByRole("button", { name: "Post review", exact: true })
				.click();
		}
		await expect.poll(fixture.isHeld).toBe(true);
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await page
			.getByRole("button", { name: "Review account controls", exact: true })
			.click();
		await page
			.getByRole("menuitem", {
				name: "Review buyer avatar Review buyer",
				exact: true,
			})
			.click();
		const secondAccount = page.getByRole("menuitem").filter({
			has: page.getByText("second@example.invalid", { exact: true }),
		});
		await expect(secondAccount).toHaveCount(1);
		await expect(
			secondAccount.getByText("Second review buyer", { exact: true })
		).toBeVisible();
		const documentBefore = await page.evaluate(() => performance.timeOrigin);
		await Promise.all([
			page.waitForEvent("load"),
			secondAccount.getByText("Second review buyer", { exact: true }).click(),
		]);
		expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(
			documentBefore
		);
		expect(readAuthVaultSlot(slots)).toMatchObject({
			activeUserId: "fixture-review-second-buyer",
			activeToken: "marketplace-detail-second-token",
		});
		expect(
			readAuthVaultSlot(slots)?.accounts.map((account) => account.userId)
		).toEqual([buyerId, "fixture-review-second-buyer"]);
		await expect.poll(() => plaintextVault(page)).toEqual([null, null, null]);
		await fixture.release();
		await page.getByText("Harbor Review Kit", { exact: true }).click();
		await more(page);
		await expect(page.getByRole("alert")).toContainText(
			"Couldn't load reviews"
		);
		await expect(
			page.getByRole("textbox", { name: "Review title" })
		).toHaveValue("");
		await expect(
			page.getByRole("button", { name: "Post review", exact: true })
		).toBeDisabled();
		await expect(page.getByText("Review posted.", { exact: true })).toHaveCount(
			0
		);
		await page
			.getByRole("button", { name: "Retry reviews", exact: true })
			.click();
		await expect(page.getByRole("alert")).toHaveCount(0);
		await expect(
			page.getByRole("textbox", { name: "Review title" })
		).toHaveValue("");
		await expect(
			page.getByRole("button", { name: "Delete", exact: true })
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Update review", exact: true })
		).toHaveCount(0);
		await page.getByRole("button", { name: "5 stars", exact: true }).click();
		await page
			.getByRole("textbox", { name: "Review title" })
			.fill("Account B current review");
		await page
			.getByRole("textbox", { name: "Review body" })
			.fill("Account B current body");
		await page
			.getByRole("button", { name: "Post review", exact: true })
			.click();
		await expect(
			page.getByText("Second account review write denied", { exact: true })
		).toBeVisible();
		await expect(
			page.getByRole("textbox", { name: "Review title" })
		).toHaveValue("Account B current review");
		await page
			.getByRole("button", { name: "Post review", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "Update review", exact: true })
		).toBeVisible();
		await page.reload();
		await page.getByText("Harbor Review Kit", { exact: true }).click();
		await more(page);
		await expect(
			page.getByRole("textbox", { name: "Review title" })
		).toHaveValue("Account B current review");
		await expect(
			page.getByRole("textbox", { name: "Review body" })
		).toHaveValue("Account B current body");
		expect(
			fixture.readReviews().filter((review) => review.userId === buyerId)
		).toHaveLength(1);
		expect(
			fixture
				.readReviews()
				.filter((review) => review.userId === "fixture-review-second-buyer")
		).toHaveLength(1);
		const writes = fixture.requests.filter(
			(request) => request.method === "POST"
		);
		expect(
			writes.map((request) => [request.authorization, request.status])
		).toEqual([
			...(held === "save"
				? [["Bearer marketplace-detail-session-token", 200]]
				: []),
			["Bearer marketplace-detail-second-token", 403],
			["Bearer marketplace-detail-second-token", 200],
		]);
		expect(
			fixture.requests.filter(
				(request) =>
					request.authorization === "Bearer marketplace-detail-session-token" &&
					request.method === "GET"
			)
		).toHaveLength(1);
		expect(
			fixture.requests.filter(
				(request) =>
					request.authorization === "Bearer marketplace-detail-second-token" &&
					request.method === "GET"
			)
		).toHaveLength(4);
		await page
			.getByRole("textbox", { name: "Review title" })
			.scrollIntoViewIfNeeded();
		await page.screenshot({
			animations: "disabled",
			fullPage: true,
			path: testInfo.outputPath(`marketplace-account-${held}-recovered.png`),
		});
	});
}
async function openLink(page: Page, name: string, expectedPath: string) {
	const popup = page.context().waitForEvent("page");
	await page
		.getByRole("link", { name, exact: true })
		.or(page.getByRole("button", { name, exact: true }))
		.or(page.getByRole("menuitem", { name, exact: true }))
		.first()
		.click();
	const opened = await popup;
	await expect(opened).toHaveURL(new RegExp(`${expectedPath}$`));
	await opened.close();
}

test("production Store listing disclosure, external actions, screenshot viewer, prompt copy and disabled runnable state work", async ({
	page,
}) => {
	const fixture = await install(page);
	await open(page);
	await page
		.getByRole("button", { name: /Summarize the selected workspace/ })
		.click();
	expect(
		await page.evaluate(
			() =>
				/* SAFETY: The installed clipboard writeText callback stores its native string input in this private slot; this read follows the actual copy action. No listing or HTTP response contract is asserted. */ (
					window as typeof window & { __marketplaceProofClipboard: string }
				).__marketplaceProofClipboard
		)
	).toBe("Summarize the selected workspace");
	await openLink(page, "Configure workspace", "/__proof/links/setup");
	await page.getByRole("button", { name: "More options", exact: true }).click();
	await openLink(page, "Website", "/__proof/links/site");
	await openLink(page, "View topic source", "/__proof/links/topic");
	await more(page);
	await expect(
		page.getByRole("switch", { name: "Read workspace enabled" })
	).toBeDisabled();
	await expect(
		page.getByRole("switch", { name: "Read workspace enabled" })
	).toBeChecked();
	await openLink(page, "Privacy Policy", "/__proof/links/privacy");
	await openLink(page, "Terms of Service", "/__proof/links/terms");
	await page
		.getByRole("button", {
			name: "Harbor Review Kit screenshot 1",
			exact: true,
		})
		.click();
	await expect(
		page.getByRole("img", { name: /screenshot 1/ }).last()
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: "More details", exact: true })
	).toHaveAttribute("aria-expanded", "true");
	await expect(page.getByRole("dialog")).toHaveCount(1);
	await page.getByRole("dialog").screenshot({
		animations: "disabled",
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-marketplace-screenshot-returned-to-listing.png"
		),
	});
	await page.getByRole("button", { name: "More details", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Reviews", exact: true })
	).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(
		fixture.requests.filter(
			(request) =>
				request.method !== "GET" &&
				["/api/marketplace/reviews", "/api/plugins/catalog/install"].includes(
					request.path
				)
		)
	).toHaveLength(0);
});

test("reviews validate rating, preserve denied drafts, paginate with retry, update/delete exact authenticated payloads and reload accepted state", async ({
	page,
}) => {
	const fixture = await install(page);
	await open(page);
	await more(page);
	await page.getByRole("button", { name: "Post review", exact: true }).click();
	expect(
		fixture.requests.filter(
			(request) =>
				request.method === "POST" && request.path === "/api/marketplace/reviews"
		)
	).toHaveLength(0);
	await page.getByRole("button", { name: "4 stars", exact: true }).click();
	await page
		.getByRole("textbox", { name: "Review title" })
		.fill("  Useful kit  ");
	await page
		.getByRole("textbox", { name: "Review body" })
		.fill("  Works for our workspace.  ");
	fixture.fail("POST", "/api/marketplace/reviews", 403, {
		requiresPurchase: true,
		message: "Only verified purchasers",
	});
	await page.getByRole("button", { name: "Post review", exact: true }).click();
	await expect(
		page.getByText(/Only verified purchasers can review/)
	).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Review title" })).toHaveValue(
		"  Useful kit  "
	);
	const expected = {
		kind: "bundle",
		id: listingId,
		rating: 4,
		title: "Useful kit",
		body: "Works for our workspace.",
	};
	expect(
		fixture.requests
			.filter(
				(request) =>
					request.method === "POST" &&
					request.path === "/api/marketplace/reviews"
			)
			.at(-1)?.body
	).toEqual(expected);
	fixture.fail("POST", "/api/marketplace/reviews", 403, {
		error: "review_locked",
		message: "Reviews are temporarily locked.",
	});
	await page.getByRole("button", { name: "Post review", exact: true }).click();
	await expect(
		page.getByText("Reviews are temporarily locked.", { exact: true })
	).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Review body" })).toHaveValue(
		"  Works for our workspace.  "
	);
	await page.getByRole("button", { name: "Post review", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Update review", exact: true })
	).toBeVisible();
	expect(
		fixture.readReviews().filter((review) => review.userId === buyerId)
	).toHaveLength(1);
	await page.getByRole("button", { name: "5 stars", exact: true }).click();
	await page
		.getByRole("textbox", { name: "Review title" })
		.fill("Updated kit review");
	await page
		.getByRole("button", { name: "Update review", exact: true })
		.click();
	await expect(
		page.getByText("Updated kit review", { exact: true })
	).toBeVisible();
	fixture.fail(
		"GET",
		`/api/marketplace/reviews?kind=bundle&id=${listingId}&limit=20&cursor=20`
	);
	await page.getByRole("button", { name: "Load more", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Couldn't load more reviews"
	);
	await expect(
		page.getByRole("button", { name: "Load more", exact: true })
	).toBeEnabled();
	await page.getByRole("button", { name: "Load more", exact: true }).click();
	await expect(
		page.getByText("Fixture review 22", { exact: true })
	).toBeVisible();
	await page.reload();
	await page.getByText("Harbor Review Kit", { exact: true }).click();
	await more(page);
	await expect(page.getByRole("textbox", { name: "Review title" })).toHaveValue(
		"Updated kit review"
	);
	const proof = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-marketplace-review-persisted.png"
	);
	await mkdir(path.dirname(proof), { recursive: true });
	await page
		.getByRole("textbox", { name: "Review title" })
		.scrollIntoViewIfNeeded();
	await page.screenshot({ animations: "disabled", path: proof });
	fixture.fail(
		"DELETE",
		`/api/marketplace/reviews?kind=bundle&id=${listingId}`
	);
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(
		page.getByText("Temporary listing request failure", { exact: true })
	).toBeVisible();
	expect(
		fixture.readReviews().some((review) => review.userId === buyerId)
	).toBe(true);
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Post review", exact: true })
	).toBeVisible();
	expect(
		fixture.readReviews().some((review) => review.userId === buyerId)
	).toBe(false);
	expect(
		fixture.requests
			.filter((request) => request.path.startsWith("/api/marketplace/reviews"))
			.every(
				(request) =>
					request.authorization === "Bearer marketplace-detail-session-token"
			)
	).toBe(true);
});

test("minimal listings retain the review entry and signed-out viewers cannot author reviews", async ({
	page,
}) => {
	const fixture = await install(page, { signedOut: true, minimal: true });
	await open(page, "?signed-out");
	await more(page);
	await expect(
		page.getByText("Sign in to write a review.", { exact: true })
	).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Review title" })).toHaveCount(
		0
	);
	await expect(
		page.getByRole("button", { name: "Post review", exact: true })
	).toHaveCount(0);
	expect(
		fixture.requests.filter(
			(request) =>
				request.method !== "GET" && request.path === "/api/marketplace/reviews"
		)
	).toHaveLength(0);
});

test("bundle install exposes a required denial, retries the exact Core install and reads accepted plugin state", async ({
	page,
}) => {
	const fixture = await install(page);
	await open(page);
	fixture.fail("POST", "/api/plugins/catalog/install", 403, {
		error: "forbidden",
		message: "Plugin installation is not permitted.",
	});
	await page
		.getByRole("button", { name: "Install bundle", exact: true })
		.click();
	await expect(
		page.getByText("Bundle installed with required items missing", {
			exact: true,
		})
	).toBeVisible();
	expect(fixture.installed.size).toBe(0);
	await page
		.getByRole("button", { name: "Install bundle", exact: true })
		.click();
	await expect
		.poll(() => fixture.installed.has("com.example.review-kit"))
		.toBe(true);
	const installed = await page.evaluate(() =>
		fetch("/api/plugins", {
			headers: { authorization: "Bearer marketplace-detail-node-token" },
		}).then((response) => response.json())
	);
	expect(installed).toEqual({
		plugins: [{ id: "com.example.review-kit", installed: true }],
	});
	expect(
		fixture.requests
			.filter((request) => request.path === "/api/plugins/catalog/install")
			.map((request) => ({
				body: request.body,
				authorization: request.authorization,
				status: request.status,
			}))
	).toEqual([
		{
			body: { id: "com.example.review-kit" },
			authorization: "Bearer marketplace-detail-node-token",
			status: 403,
		},
		{
			body: { id: "com.example.review-kit" },
			authorization: "Bearer marketplace-detail-node-token",
			status: 200,
		},
	]);
});

test("initial review read failure reports recovery and disables authoring until the existing review is resolved", async ({
	page,
}) => {
	const fixture = await install(page, { ownReview: true });
	fixture.fail(
		"GET",
		`/api/marketplace/reviews?kind=bundle&id=${listingId}&limit=20`
	);
	await open(page);
	await more(page);
	await expect(page.getByRole("alert")).toContainText("Couldn't load reviews");
	await expect(
		page.getByRole("textbox", { name: "Review title" })
	).toBeDisabled();
	await expect(
		page.getByText("No reviews yet. Be the first to review this item.", {
			exact: true,
		})
	).toHaveCount(0);
	await page
		.getByRole("button", { name: "Retry reviews", exact: true })
		.click();
	await expect(page.getByRole("textbox", { name: "Review title" })).toHaveValue(
		"Existing review"
	);
	await expect(
		page.getByRole("button", { name: "Update review", exact: true })
	).toBeEnabled();
	await expect(page.getByRole("alert")).toHaveCount(0);
});
