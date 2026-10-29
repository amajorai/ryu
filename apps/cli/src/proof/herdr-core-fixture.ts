// Local deterministic Core fixture for exercising the real TUI in a Herdr pane.
// Run from apps/cli: bun run src/proof/herdr-core-fixture.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	herdrFixtureChatSchema,
	herdrFixturePromptSchema,
	herdrFixtureTurnSchema,
	parseFixtureJson,
} from "./cli-fixture-contract.ts";

const log = resolve(
	import.meta.dir,
	"../../../../docs/proof/herdr/core-requests.jsonl"
);
mkdirSync(dirname(log), { recursive: true });
const conversations = new Map<
	string,
	{ id: string; role: string; content: string }[]
>();
let proceed: (() => void) | undefined;
let requestNumber = 0;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

Bun.serve({
	hostname: "127.0.0.1",
	port: 18_981,
	idleTimeout: 255,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		appendFileSync(
			log,
			`${JSON.stringify({ at: new Date().toISOString(), path, method: request.method })}\n`
		);
		if (path === "/api/chat/permission" || path === "/api/chat/question") {
			proceed?.();
			return Response.json({ resolved: true });
		}
		if (path.startsWith("/api/conversations/")) {
			const id = decodeURIComponent(path.slice("/api/conversations/".length));
			return Response.json({
				id,
				title: "Herdr integration verification",
				messages: conversations.get(id) ?? [],
			});
		}
		if (path === "/api/chat/stream") {
			let rawBody;
			try {
				rawBody = parseFixtureJson(await request.text());
			} catch {
				return new Response("Invalid fixture request", { status: 400 });
			}
			const parsedBody = herdrFixtureChatSchema.safeParse(rawBody);
			if (!parsedBody.success) {
				return new Response("Invalid fixture request", { status: 400 });
			}
			const body = parsedBody.data;
			const id = body.conversation_id;
			const turn = herdrFixtureTurnSchema.safeParse(body.messages.at(-1));
			if (!turn.success) {
				return new Response("Invalid fixture turn", { status: 400 });
			}
			const part = herdrFixturePromptSchema.safeParse(turn.data.content[0]);
			if (!part.success) {
				return new Response("Invalid fixture prompt", { status: 400 });
			}
			const prompt = part.data.text;
			const count = ++requestNumber;
			appendFileSync(
				log,
				`${JSON.stringify({ at: new Date().toISOString(), conversationId: id, routing: rawBody, fixture: true })}\n`
			);
			const messages = conversations.get(id) ?? [];
			messages.push({ id: `user-${count}`, role: "user", content: prompt });
			conversations.set(id, messages);
			const stream = new ReadableStream({
				async start(controller) {
					const frame = <Payload>(value: Payload) =>
						controller.enqueue(
							new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
						);
					frame({
						type: "text-delta",
						delta: "Checking Herdr integration... ",
					});
					await sleep(2000);
					if (prompt.includes("permission")) {
						const wait = new Promise<void>((done) => {
							proceed = done;
						});
						frame({
							type: "data-ryu-permission",
							data: {
								requestId: "herdr-permission",
								toolCall: { title: "verify the Herdr pane" },
								options: [
									{ kind: "allow_once", name: "Allow once", optionId: "allow" },
									{ kind: "reject_once", name: "Reject", optionId: "reject" },
								],
							},
						});
						await wait;
					} else if (prompt.includes("question")) {
						const wait = new Promise<void>((done) => {
							proceed = done;
						});
						frame({
							type: "data-ryu-question",
							toolCallId: "herdr-question",
							data: {
								questions: [
									{
										id: "choice",
										title: "Finish the integration check?",
										kind: "single",
										options: [{ id: "yes", label: "Finish verification" }],
									},
								],
							},
						});
						await wait;
					}
					await sleep(2000);
					const content =
						"Herdr integration verified. Ryu reports working, blocked, and idle. This conversation can be restored after a Herdr restart.";
					frame({ type: "text-delta", delta: content });
					messages.push({
						id: `assistant-${count}`,
						role: "assistant",
						content: `Checking Herdr integration... ${content}`,
					});
					frame({ type: "finish" });
					controller.close();
				},
			});
			return new Response(stream, {
				headers: { "Content-Type": "text/event-stream" },
			});
		}
		if (path === "/api/health") {
			return Response.json({ status: "ok" });
		}
		if (path === "/api/auth/status") {
			return Response.json({});
		}
		if (path.includes("contributions")) {
			return Response.json({ contributions: [], views: [] });
		}
		if (path === "/api/agents") {
			return Response.json([]);
		}
		if (path === "/api/conversations") {
			return Response.json([]);
		}
		return new Response("Fixture endpoint unavailable", { status: 404 });
	},
});
