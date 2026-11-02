import { expect, type Page, type Route } from "@playwright/test";
import { z } from "zod";
import type { Review } from "@/src/lib/api/marketplace.ts";

// Fixtures and helpers for marketplace-detail-proof.spec.ts, kept apart so each file stays under the token limit.

export const listingId = "fixture-review-kit";
export const buyerId = "fixture-review-buyer";
export const time = "2026-10-02T00:00:00.000Z";
export interface RequestLog {
	authorization: string | undefined;
	body: unknown;
	method: string;
	path: string;
	status: number;
}

export async function install(
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

export async function open(page: Page, query = "") {
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
export async function more(page: Page) {
	await page.getByRole("button", { name: "More details", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Reviews", exact: true })
	).toBeVisible();
}

/** Keep the request's account fixed across a real AccountList switch/reload.
 * Only these two control-plane endpoints are intercepted by this fixture. */
export async function accountReviewTransport(
	page: Page,
	held: "read" | "save"
) {
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
