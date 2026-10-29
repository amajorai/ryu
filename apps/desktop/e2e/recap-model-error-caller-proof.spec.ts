import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const proof = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/parallel/plugins-runtime/full/recap-ui"
);
const conversationId = "conversation-toolbar-share-fixture";

test.describe.configure({ timeout: 180_000 });

test("ChatPage keeps a real Recap model failure local and persists the explicit retry", async ({
	page,
	request,
}) => {
	const coreOrigin = process.env.RYU_RECAP_PROOF_CORE_URL;
	const token = process.env.RYU_RECAP_PROOF_CORE_TOKEN;
	if (
		!coreOrigin ||
		new URL(coreOrigin).hostname !== "127.0.0.1" ||
		!token?.startsWith("ryu-fixture-")
	) {
		throw new Error(
			"An explicit isolated loopback Core and synthetic token are required"
		);
	}
	mkdirSync(proof, { recursive: true });
	const errors: string[] = [];
	const bodies: unknown[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.addInitScript(() => {
		Object.assign(window, {
			__recapProofNativeFetch: globalThis.fetch.bind(globalThis),
		});
	});
	await page.route("**/api/chat/stream", async (route) => {
		bodies.push(route.request().postDataJSON());
		const response = await route.fetch({
			url: `${coreOrigin}/api/chat/stream`,
			headers: {
				...route.request().headers(),
				authorization: `Bearer ${token}`,
			},
		});
		await page.evaluate(() =>
			Object.assign(window, { __recapProofLiveHistory: true })
		);
		await route.fulfill({ response });
	});
	await page.route("**/api/conversations/**", async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname !== `/api/conversations/${conversationId}`) {
			return route.continue();
		}
		const response = await route.fetch({
			url: `${coreOrigin}${url.pathname}${url.search}`,
			headers: {
				...route.request().headers(),
				authorization: `Bearer ${token}`,
			},
		});
		await route.fulfill({ response });
	});
	await page.goto(
		"/share-conversation-toolbar-entry.html?scenario=plugin-command-storage"
	);
	await expect(page.getByPlaceholder("Ask a follow up")).toBeVisible();
	await page.evaluate(() => {
		const baseline = globalThis.fetch.bind(globalThis);
		const native =
			/* SAFETY: This proof installs __recapProofNativeFetch with the complete native fetch bound to globalThis in addInitScript before loading this page. The same actual native fetch input and Response contract is retained; no response DTO is asserted. */ (
				window as typeof window & { __recapProofNativeFetch: typeof fetch }
			).__recapProofNativeFetch;
		globalThis.fetch = (input, init) => {
			const url = new URL(
				input instanceof Request ? input.url : String(input),
				location.href
			);
			if (url.pathname === "/api/preferences/voice-mode-readback") {
				return Promise.resolve(
					Response.json({
						key: "voice-mode-readback",
						value: JSON.stringify({ enabled: false }),
					})
				);
			}
			const liveHistory =
				/* SAFETY: The sole authored writer sets this optional private flag to true after the real chat-stream route fetch; before that it is absent. This view adds no message or response field contract. */ (
					window as typeof window & { __recapProofLiveHistory?: boolean }
				).__recapProofLiveHistory;
			return url.pathname === "/api/chat/stream" ||
				(liveHistory &&
					url.pathname ===
						"/api/conversations/conversation-toolbar-share-fixture")
				? native(input, init)
				: baseline(input, init);
		};
	});
	const hidePanel = page
		.getByRole("button", { name: "Hide right panel", exact: true })
		.first();
	if (await hidePanel.isVisible()) {
		await hidePanel.click();
	}
	const cases = [
		{
			command: "/recap focus on browser proof",
			reply:
				"Couldn't generate the recap. Check the recap model in Settings → Recap, then try again.",
			name: "refused",
		},
		{
			command: "/recap",
			reply: "Recap: local command history was summarized.",
			name: "retried",
		},
	];
	for (const [index, entry] of cases.entries()) {
		await page.getByPlaceholder("Ask a follow up").fill(entry.command);
		await page.getByRole("button", { name: "Send", exact: true }).click();
		const reply = page.getByText(entry.reply, { exact: index === 0 }).last();
		await expect(reply).toBeVisible();
		await expect(page.getByPlaceholder("Ask a follow up")).toHaveValue("");
		expect(bodies).toHaveLength(index + 1);
		expect(bodies[index]).toMatchObject({ conversation_id: conversationId });
		const historyResponse = await request.get(
			`${coreOrigin}/api/conversations/${conversationId}`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect(historyResponse.ok()).toBe(true);
		const history = await historyResponse.json();
		expect(history.messages).toHaveLength(2 * (index + 1));
		expect(history.messages.at(-2)).toMatchObject({
			role: "user",
			content: entry.command,
		});
		expect(history.messages.at(-1)?.content).toContain(entry.reply);
		expect(history.messages.at(-1)?.content).not.toContain("Unknown agent");
		writeFileSync(
			path.join(proof, `${entry.name}-readback.json`),
			`${JSON.stringify({ request: bodies[index], history }, null, 2)}\n`
		);
		const hideRight = page
			.getByRole("button", { name: "Hide right panel", exact: true })
			.first();
		if (await hideRight.isVisible()) {
			await hideRight.click();
		}
		await expect(
			page.getByText("Connection restored", { exact: true })
		).not.toBeVisible({ timeout: 10_000 });
		await reply.evaluate(async (element) => {
			await Promise.all(
				document
					.getAnimations()
					.filter((animation) => {
						const timing = animation.effect?.getComputedTiming();
						return (
							animation.effect instanceof KeyframeEffect &&
							animation.effect.target instanceof Element &&
							animation.effect.target.contains(element) &&
							animation.playState === "running" &&
							timing?.iterations !== Number.POSITIVE_INFINITY &&
							Number.isFinite(timing?.endTime) &&
							Number(timing?.endTime) <= 6000
						);
					})
					.map((animation) => animation.finished.catch(() => undefined))
			);
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			);
		});
		await page.mouse.move(12, 12);
		await expect
			.poll(async () => {
				const geometry = await reply.evaluate((element) => {
					const range = document.createRange();
					range.selectNodeContents(element);
					const rects = [...range.getClientRects()].filter(
						(rect) => rect.width > 0
					);
					let left = 0;
					let right = innerWidth;
					const clips = [];
					for (
						let ancestor = element.parentElement;
						ancestor;
						ancestor = ancestor.parentElement
					) {
						const style = getComputedStyle(ancestor);
						if (
							!["contents", "inline"].includes(style.display) &&
							["auto", "scroll", "hidden", "clip"].includes(style.overflowX)
						) {
							const box = ancestor.getBoundingClientRect();
							left = Math.max(left, box.left);
							right = Math.min(right, box.right);
							clips.push({
								className: ancestor.className,
								left: box.left,
								right: box.right,
								scrollLeft: ancestor.scrollLeft,
							});
						}
					}
					const box = element.getBoundingClientRect();
					return {
						within:
							rects.length > 0 &&
							rects.every(
								(rect) => rect.left >= left - 1 && rect.right <= right + 1
							) &&
							box.top >= 0 &&
							box.bottom <= innerHeight,
						left,
						right,
						clips,
						textRects: rects.map((rect) => ({
							left: rect.left,
							right: rect.right,
						})),
					};
				});
				writeFileSync(
					path.join(proof, `${entry.name}-geometry.json`),
					`${JSON.stringify(geometry, null, 2)}\n`
				);
				return geometry.within;
			})
			.toBe(true);
		await page.screenshot({
			path: path.join(proof, `${entry.name}-completed.png`),
			animations: "disabled",
		});
	}
	expect(errors).toEqual([]);
});
