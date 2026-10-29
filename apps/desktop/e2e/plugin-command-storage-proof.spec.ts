// Production Layout/ChatPage projection with shipped hook bodies and a local storage fixture.
// Core registry/sandbox execution is verified separately by hooks_runtime_tests.rs.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { expect, test } from "@playwright/test";
import { z } from "zod";

const conversationId = "conversation-toolbar-share-fixture";
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const evidence = path.join(
	repoRoot,
	"docs/proof/test-coverage-sweep-20260924/parallel/plugins-runtime"
);
test.describe.configure({ timeout: 120_000 });

async function commandReply(plugin: string, input: string, refuse: boolean) {
	const code = readFileSync(
		path.join(repoRoot, "plugins-store/plugins", plugin, "hooks/command.js"),
		"utf8"
	);
	const state = {
		entries: [{ text: "Previous recap", turn: 1 }],
		muted: false,
	};
	const reply: unknown = await vm.runInNewContext(
		`(async () => { ${code}\n })()`,
		{
			ctx: { input, conversation_id: conversationId },
			host: {
				storage: {
					get: async () => JSON.stringify(state),
					set: async () => !refuse,
					delete: async () => !refuse,
				},
				log: () => undefined,
			},
		}
	);
	return z.object({ text: z.string() }).parse(reply).text;
}

test("ChatPage shows refused command storage and successful explicit retries", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(
		"/share-conversation-toolbar-entry.html?scenario=plugin-command-storage"
	);
	await expect(page.getByPlaceholder("Ask a follow up")).toBeVisible();
	const cases = [
		{ plugin: "recap", command: "/recap off", refuse: true },
		{ plugin: "recap", command: "/recap off", refuse: false },
		{ plugin: "recap", command: "/recap clear", refuse: true },
		{ plugin: "recap", command: "/recap clear", refuse: false },
		{ plugin: "security-scanner", command: "/security-clear", refuse: true },
		{ plugin: "security-scanner", command: "/security-clear", refuse: false },
	];
	for (const [index, entry] of cases.entries()) {
		const text = await commandReply(entry.plugin, entry.command, entry.refuse);
		await page.evaluate(
			({ text, index }) => {
				const previous = globalThis.fetch.bind(globalThis);
				globalThis.fetch = async (input, init) => {
					const url = new URL(
						input instanceof Request ? input.url : String(input),
						location.href
					);
					if (url.pathname === "/api/preferences/voice-mode-readback") {
						return Response.json({
							key: "voice-mode-readback",
							value: JSON.stringify({ enabled: false }),
						});
					}
					if (url.pathname !== "/api/chat/stream") {
						return previous(input, init);
					}
					const fixture =
						/* SAFETY: This private capture slot is initialized with an array by the following nullish assignment and retained across iterations; its sole writer appends raw JSON values. Only the container is described, and every element remains unknown. */ window as typeof window & {
							__pluginCommandBodies: unknown[];
						};
					fixture.__pluginCommandBodies ??= [];
					fixture.__pluginCommandBodies.push(JSON.parse(String(init?.body)));
					const parts = [
						{ type: "start", messageId: `plugin-command-${index}` },
						{ type: "text-start", id: "reply" },
						{ type: "text-delta", id: "reply", delta: text },
						{ type: "text-end", id: "reply" },
						{ type: "finish" },
					];
					return new Response(
						parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") +
							"data: [DONE]\n\n",
						{
							headers: {
								"content-type": "text/event-stream",
								"x-vercel-ai-ui-message-stream": "v1",
							},
						}
					);
				};
			},
			{ text, index }
		);
		await page.getByPlaceholder("Ask a follow up").fill(entry.command);
		await page.getByRole("button", { name: "Send", exact: true }).click();
		const reply = page
			.getByText(text.replaceAll("`", ""), { exact: true })
			.last();
		await expect(reply).toBeVisible();
		await page.mouse.move(12, 12);
		const hideRightPanel = page
			.getByRole("button", { name: "Hide right panel", exact: true })
			.first();
		if (await hideRightPanel.isVisible()) {
			await hideRightPanel.click();
			await page.mouse.move(12, 12);
		}
		await expect
			.poll(async () => {
				const geometry = await reply.evaluate((element) => {
					const range = document.createRange();
					range.selectNodeContents(element);
					const textRects = [...range.getClientRects()].filter(
						(rect) => rect.width > 0
					);
					let left = 0;
					let right = innerWidth;
					const clips: Array<{
						className: string;
						left: number;
						right: number;
						width: number;
						display: string;
					}> = [];
					for (
						let ancestor = element.parentElement;
						ancestor;
						ancestor = ancestor.parentElement
					) {
						const style = getComputedStyle(ancestor);
						if (
							style.display !== "contents" &&
							style.display !== "inline" &&
							["auto", "scroll", "hidden", "clip"].includes(style.overflowX)
						) {
							const bounds = ancestor.getBoundingClientRect();
							clips.push({
								className: ancestor.className,
								left: bounds.left,
								right: bounds.right,
								width: bounds.width,
								display: style.display,
							});
							left = Math.max(left, bounds.left);
							right = Math.min(right, bounds.right);
						}
					}
					return {
						within:
							textRects.length > 0 &&
							textRects.every(
								(rect) => rect.left >= left - 1 && rect.right <= right + 1
							),
						left,
						right,
						clips,
						rects: textRects.map((rect) => ({
							left: rect.left,
							right: rect.right,
							width: rect.width,
						})),
					};
				});
				writeFileSync(
					path.join(evidence, "commands-clipping-geometry.json"),
					JSON.stringify({ index, ...geometry }, null, 2)
				);
				return geometry.within;
			})
			.toBe(true);
		await expect(page.getByPlaceholder("Ask a follow up")).toHaveValue("");
		const bodies = await page.evaluate(
			() =>
				/* SAFETY: The same proof callback initializes this private capture array and appends raw JSON values before the awaited reply becomes visible. This read preserves the whole unknown-valued log; the later request DTO assertion remains separate. */ (
					window as typeof window & { __pluginCommandBodies: unknown[] }
				).__pluginCommandBodies
		);
		expect(bodies).toHaveLength(index + 1);
		const request = z
			.object({
				conversation_id: z.string(),
				messages: z.array(
					z.object({ role: z.string(), parts: z.array(z.json()) })
				),
				worktree_isolation: z.boolean(),
			})
			.parse(bodies[index]);
		expect(request.conversation_id).toBe(conversationId);
		expect(request.worktree_isolation).toBe(false);
		expect(request.messages.at(-1)).toMatchObject({
			role: "user",
			parts: [{ type: "text", text: entry.command }],
		});
		expect(request.messages.at(-1)?.parts).toHaveLength(1);
		writeFileSync(
			path.join(evidence, "commands-requests.json"),
			JSON.stringify(bodies, null, 2)
		);
		if (index === 3 || index === 5) {
			await page.screenshot({
				path: path.join(evidence, `commands-${entry.plugin}-retry.png`),
				animations: "disabled",
			});
		}
	}
	expect(errors).toEqual([]);
});
