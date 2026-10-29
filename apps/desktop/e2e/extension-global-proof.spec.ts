import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import {
	type PluginValue,
	pluginValueSchema,
} from "../src/lib/api/plugin-wire-values.ts";

const openWidgetInputSchema = z.object({ idempotencyKey: z.string() });
const followUpInputSchema = z.object({ prompt: z.string() });

const proofDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/extension-parity"
);
test.afterEach(async ({ page }, info) => {
	if (info.status !== info.expectedStatus) {
		await mkdir(proofDir, { recursive: true });
		await page.screenshot({
			path: path.join(proofDir, "global-failure.png"),
			fullPage: true,
		});
		await writeFile(
			path.join(proofDir, "global-failure.txt"),
			await page.locator("body").innerText()
		);
	}
});
const html = `<!doctype html><html><head><style>body{font-family:var(--font-sans,system-ui);background:var(--background);color:var(--foreground);padding:16px}button{font:inherit;padding:8px;margin:4px;border:1px solid var(--border);border-radius:var(--radius);background:var(--secondary);color:var(--secondary-foreground)}</style></head><body><h2>Parts selection</h2><button id="context">Share selected bolt</button><button id="tool">Open quantity form</button><button id="message">Ask about selection</button><p id="status">Connecting</p><script>
let next=1;const pending=new Map();function call(method,params={}){return new Promise((resolve,reject)=>{const id=next++;pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method,params},'*');});}addEventListener('message',event=>{const data=event.data;if(data?.jsonrpc!=='2.0')return;const waiter=pending.get(data.id);if(waiter){pending.delete(data.id);data.error?waiter.reject(new Error(data.error.message)):waiter.resolve(data.result);}});call('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'Parts',version:'1.0'},appCapabilities:{}}).then(()=>{parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');document.getElementById('status').textContent='Connected';});document.getElementById('context').onclick=()=>call('ui/update-model-context',{content:[{type:'text',text:'Selected M6 bolt'}],structuredContent:{part:'bolt'}}).then(()=>document.getElementById('status').textContent='Selection shared');document.getElementById('tool').onclick=()=>call('tools/call',{name:'parts.quantity',arguments:{}}).then(()=>document.getElementById('status').textContent='Quantity confirmed');
document.getElementById('message').onclick=()=>call('ui/message',{role:'user',content:[{type:'text',text:'Explain the selected bolt'}]}).then(()=>document.getElementById('status').textContent='Question sent');
</script></body></html>`;
async function installFixture(page: Page) {
	const errors: string[] = [];
	const calls: { path: string; method: string; body: PluginValue }[] = [];
	let formOpen = true;
	let activated = false;
	let widgetForm = false;
	page.on("pageerror", (error) => {
		errors.push(error.message);
		process.stderr.write(`Global fixture page error: ${error.message}\n`);
	});
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const pathname = url.pathname;
		const body = pluginValueSchema.parse(request.postDataJSON());
		calls.push({ path: pathname, method: request.method(), body });
		if (pathname === "/api/chat/stream") {
			const chunks = [
				{ type: "start", messageId: "fixture-answer" },
				{ type: "text-start", id: "answer" },
				{
					type: "text-delta",
					id: "answer",
					delta: "Quantity 4 selected for the M6 bolt.",
				},
				{ type: "text-end", id: "answer" },
				{ type: "finish" },
			];
			await route.fulfill({
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-vercel-ai-ui-message-stream": "v1",
				},
				body:
					chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
					"data: [DONE]\n\n",
			});
			return;
		}
		let response: PluginValue = {};
		let status = 200;
		if (pathname.startsWith("/api/cloud-environments/task-binding/")) {
			response = { cloudEnvironmentId: null };
		} else if (pathname === "/api/agents") {
			response = {
				agents: [
					{
						id: "ryu",
						name: "Ryu",
						title: "Assistant",
						description: "Local fixture",
						transport: "acp",
						engine: "ryu",
						installed: true,
						recommended: true,
					},
				],
			};
		} else if (pathname === "/api/agents/ryu") {
			response = {
				id: "ryu",
				name: "Ryu",
				tools: [],
				engine: "acp:ryu",
				built_in: true,
			};
		} else if (pathname === "/api/system/status") {
			response = {
				engine: { active: "ryu", running: true },
				gateway: { reachable: true },
				sidecars: [],
			};
		} else if (pathname === "/api/widgets/open") {
			if (activated) {
				response = {
					type: "data-tool-widget-available",
					data: {
						conversationId: "app-conversation",
						toolCallId: "open-call",
						toolName: "parts.open",
						instanceId: "parts-instance",
						serverId: "parts",
						toolInput: {},
						toolOutput: { part: "bolt" },
						toolResponseMetadata: {},
						widgetAccessible: true,
						approvedGrants: [
							"assistant:context",
							"tool:call",
							"ui:send_message",
						],
						widget: { html, mimeType: "text/html;profile=mcp-app" },
					},
				};
			} else {
				status = 202;
				response = {
					status: "pending",
					idempotencyKey: openWidgetInputSchema.parse(body).idempotencyKey,
					conversationId: "app-conversation",
				};
			}
		} else if (pathname === "/api/chat/forms" && request.method() === "GET") {
			response = {
				forms: formOpen
					? [
							{
								id: widgetForm ? "quantity-form" : "opening-form",
								conversation_id: "app-conversation",
								server: "Local Parts",
								message: widgetForm
									? "Confirm widget quantity"
									: "Choose initial quantity",
								requested_schema: {
									type: "object",
									properties: {
										quantity: {
											type: "integer",
											title: "Quantity",
											minimum: 1,
											maximum: 10,
											default: 2,
										},
									},
									required: ["quantity"],
								},
							},
						]
					: [],
			};
		} else if (pathname === "/api/chat/forms") {
			formOpen = false;
			activated = true;
			response = { resolved: true };
		} else if (pathname === "/api/widgets/follow-up") {
			response = {
				ok: true,
				ticket: "fixture-follow-up-ticket",
				injected: {
					conversation_id: "app-conversation",
					origin_server: "parts",
					prompt: followUpInputSchema.parse(body).prompt,
					role: "user",
					source: "widget",
					tool_call_id: "open-call",
					widget_instance_id: "parts-instance",
				},
			};
		} else if (pathname === "/api/widgets/tools/call") {
			formOpen = true;
			widgetForm = true;
			await expect(
				page.getByText("Confirm widget quantity", { exact: true })
			).toBeVisible();
			await expect.poll(() => formOpen).toBe(false);
			response = { ok: true, output: { quantity: 4 } };
		} else if (pathname === "/api/conversations") {
			response = { conversations: [] };
		} else if (pathname === "/api/conversations/app-conversation") {
			response = {
				id: "app-conversation",
				title: "Parts app",
				agent_id: "ryu",
				messages: [],
			};
		} else if (pathname.endsWith("/participants")) {
			response = { participants: [] };
		} else if (pathname === "/api/plugins/contributions") {
			response = {
				companions: [],
				chat_features: [],
				composer_controls: [],
				sidebar_sections: [],
			};
		} else if (pathname === "/api/spaces") {
			response = { spaces: [] };
		} else if (pathname === "/api/engines") {
			response = { engines: [] };
		} else if (pathname.includes("models")) {
			response = { models: [] };
		} else if (pathname === "/api/apps") {
			response = { apps: [] };
		}
		await route.fulfill({
			status,
			contentType: "application/json",
			body: JSON.stringify(response),
		});
	});
	return { errors, calls };
}
test("global activation exposes pending form and real composer; idle widget form and actor isolation", async ({
	page,
}) => {
	const { errors, calls } = await installFixture(page);
	await page.goto("/extension-global-proof.html");
	await page
		.getByRole("combobox", { name: "Agent", exact: true })
		.selectOption("ryu");
	await page.getByRole("button", { name: "Open app", exact: true }).click();
	await expect(page.getByTestId("mcp-app-thread-layout")).toBeVisible();
	await expect(
		page.getByText("Choose initial quantity", { exact: true })
	).toBeVisible();
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "global-pending-form.png"),
		fullPage: true,
	});
	await page.getByRole("spinbutton", { name: "Quantity" }).fill("3");
	await page.getByRole("button", { name: "Submit", exact: true }).click();
	const frame = page.frameLocator("iframe");
	await expect(frame.getByText("Connected", { exact: true })).toBeVisible();
	await frame.getByRole("button", { name: "Share selected bolt" }).click();
	await expect(
		frame.getByText("Selection shared", { exact: true })
	).toBeVisible();
	await expect(page.getByTestId("model-context-attachments")).toContainText(
		"Selected M6 bolt"
	);
	await expect(
		page.getByText("Assistant-only torque limit", { exact: true })
	).toHaveCount(0);
	await frame.getByRole("button", { name: "Open quantity form" }).click();
	await expect(
		page.getByText("Confirm widget quantity", { exact: true })
	).toBeVisible();
	await page.getByRole("spinbutton", { name: "Quantity" }).fill("4");
	await page.getByRole("button", { name: "Submit", exact: true }).click();
	await expect(
		frame.getByText("Quantity confirmed", { exact: true })
	).toBeVisible();
	const composer = page
		.getByRole("region", { name: "App conversation", exact: true })
		.getByRole("textbox");
	await expect(composer).toBeVisible();
	await frame.getByRole("button", { name: "Ask about selection" }).click();
	await expect(frame.getByText("Question sent", { exact: true })).toBeVisible();
	const appSent = calls.find(
		(call) =>
			call.path === "/api/chat/stream" &&
			JSON.stringify(call.body).includes("fixture-follow-up-ticket")
	);
	expect(JSON.stringify(appSent?.body)).toContain("Selected M6 bolt");
	expect(appSent?.body).toMatchObject({
		messages: expect.arrayContaining([
			expect.objectContaining({
				parts: expect.arrayContaining([
					{
						type: "text",
						text: '<app-context>\n{"part":"bolt"}\n</app-context>',
					},
				]),
			}),
		]),
	});
	await composer.fill("Confirm my selected part");
	await composer.press("Enter");
	await expect(
		page.getByText("Quantity 4 selected for the M6 bolt.", { exact: true })
	).toBeVisible();
	await expect(frame.getByText("Question sent", { exact: true })).toBeVisible();
	const sent = calls.find((call) => call.path === "/api/chat/stream");
	expect(JSON.stringify(sent?.body)).toContain("Selected M6 bolt");
	expect(JSON.stringify(sent?.body)).toContain("app-conversation");
	await expect
		.poll(async () => {
			const input = await composer.boundingBox();
			const context = await page
				.getByTestId("model-context-attachments")
				.boundingBox();
			return Boolean(input && context && input.y >= context.y + context.height);
		})
		.toBe(true);
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "global-completed-light.png"),
		fullPage: true,
	});
	await page.getByRole("button", { name: "Switch theme" }).click();
	await expect
		.poll(() =>
			page
				.getByRole("button", { name: "Switch theme" })
				.evaluate(
					(element) =>
						element
							.getAnimations()
							.filter((animation) => animation.playState === "running").length
				)
		)
		.toBe(0);
	await page.screenshot({
		path: path.join(proofDir, "global-completed-dark.png"),
		fullPage: true,
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page
		.getByText("Quantity 4 selected for the M6 bolt.", { exact: true })
		.scrollIntoViewIfNeeded();
	await page
		.locator('[data-slot="message-scroller-viewport"]')
		.evaluate((element) => {
			element.scrollTop = Math.max(0, element.scrollTop - 20);
		});
	await page.screenshot({
		path: path.join(proofDir, "global-completed-narrow.png"),
		fullPage: true,
	});
	await page.getByRole("button", { name: "Switch actor" }).click();
	await expect(page.getByTestId("mcp-app-thread-layout")).toHaveCount(0);
	await expect(
		page.getByRole("combobox", { name: "Agent", exact: true })
	).toHaveValue("");
	await writeFile(
		path.join(proofDir, "global-ui-log.json"),
		JSON.stringify(
			{
				scope: "Local endpoint fixture, production McpAppPanel/ChatPage",
				errors,
				calls,
			},
			null,
			2
		)
	);
	expect(errors).toEqual([]);
});

test("standalone file app resolves an opener form and an idle widget form without a conversation pane", async ({
	page,
}) => {
	const { errors, calls } = await installFixture(page);
	await page.goto("/extension-global-proof.html?file=1");
	await page
		.getByRole("combobox", { name: "Agent", exact: true })
		.selectOption("ryu");
	await page.getByRole("button", { name: "Open app", exact: true }).click();
	await expect(
		page.getByText("Choose initial quantity", { exact: true })
	).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(1);
	await expect(page.getByTestId("mcp-app-thread-layout")).toHaveCount(0);
	await page.getByRole("spinbutton", { name: "Quantity" }).fill("3");
	await page.getByRole("button", { name: "Submit", exact: true }).click();
	const frame = page.frameLocator("iframe");
	await expect(frame.getByText("Connected", { exact: true })).toBeVisible();
	await frame.getByRole("button", { name: "Open quantity form" }).click();
	await expect(
		page.getByText("Confirm widget quantity", { exact: true })
	).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(1);
	await page.getByRole("spinbutton", { name: "Quantity" }).fill("4");
	await page.getByRole("button", { name: "Submit", exact: true }).click();
	await expect(
		frame.getByText("Quantity confirmed", { exact: true })
	).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(
		calls.find((call) => call.path === "/api/widgets/open")?.body
	).toMatchObject({
		arguments: {
			file: {
				name: "selected-parts.txt",
				resourceUri: "file:///local-verification/selected-parts.txt",
			},
		},
	});
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "file-app-forms-completed.png"),
		fullPage: true,
	});
	await writeFile(
		path.join(proofDir, "file-app-forms-log.json"),
		JSON.stringify(
			{
				scope:
					"Local endpoint fixture; production standalone file McpAppPanel/McpForms",
				errors,
				calls,
			},
			null,
			2
		)
	);
	expect(errors).toEqual([]);
});

test("production assistant app context keeps its composer editable and sends selected context", async ({
	page,
}) => {
	const { errors, calls } = await installFixture(page);
	await page.goto("/extension-global-proof.html?assistant=1");
	await page
		.getByRole("button", { name: "Dismiss legacy page context", exact: true })
		.click();
	await expect(page.getByTestId("model-context-attachments")).toContainText(
		"Selected M6 bolt"
	);
	const composer = page.getByRole("textbox");
	await expect(composer).toBeEditable();
	await composer.fill("Confirm the assistant selection");
	await composer.press("Enter");
	await expect(
		page.getByText("Quantity 4 selected for the M6 bolt.", { exact: true })
	).toBeVisible();
	await expect(page.getByTestId("user-message-bubble")).toHaveText(
		"Confirm the assistant selection"
	);
	await expect(
		page.getByText("Assistant-only torque limit", { exact: true })
	).toHaveCount(0);
	const outgoing = JSON.stringify(
		calls.find((call) => call.path === "/api/chat/stream")?.body
	);
	expect(outgoing).toContain("Selected M6 bolt");
	expect(outgoing).toContain("Assistant-only torque limit");
	expect(outgoing.match(/data:image\/png;base64/g)).toHaveLength(1);
	await expect(composer).toBeEditable();
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "assistant-context-completed.png"),
		fullPage: true,
	});
	await writeFile(
		path.join(proofDir, "assistant-context-log.json"),
		JSON.stringify(
			{
				scope:
					"Local endpoint/context fixture; production AssistantPanel and shared editable AgentChat",
				errors,
				calls,
			},
			null,
			2
		)
	);
	expect(errors).toEqual([]);
});
