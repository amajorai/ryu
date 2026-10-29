import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";

interface ManagedBotRequestRecord {
	authorization: string | null;
	body: ProofJsonValue;
	method: string;
	path: string;
}

interface ManagedBotFixtureState {
	confirmationAttempts: number;
	mode: string;
	pairAttempts: number;
	requests: ManagedBotRequestRecord[];
	statusPolls: number;
}

function sendJson<FixturePayload>(
	response: ServerResponse,
	status: number,
	value: FixturePayload
): void {
	response.statusCode = status;
	response.setHeader("Content-Type", "application/json");
	response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<ProofJsonValue> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.from(chunk));
	}
	if (chunks.length === 0) {
		return null;
	}
	return parseProofJson(Buffer.concat(chunks).toString("utf8"));
}

function recordRequest(
	state: ManagedBotFixtureState,
	request: IncomingMessage,
	path: string,
	body: ProofJsonValue
): void {
	state.requests.push({
		authorization: request.headers.authorization ?? null,
		body,
		method: request.method ?? "GET",
		path,
	});
}

function botStatus() {
	return {
		bot_id: 5_010_000_123,
		bot_username: "ryu_fixture_bot",
		owner_telegram_user_id: 7_770_001,
		status: "confirm",
	} as const;
}

export function telegramManagedBotFixture(): Plugin {
	const state: ManagedBotFixtureState = {
		confirmationAttempts: 0,
		mode: "waiting",
		pairAttempts: 0,
		requests: [],
		statusPolls: 0,
	};

	return {
		name: "telegram-managed-bot-local-core-fixture",
		configureServer(server) {
			server.middlewares.use(async (request, response, next) => {
				const url = new URL(request.url ?? "/", "http://127.0.0.1");
				const method = request.method ?? "GET";

				if (
					url.pathname === "/__fixture/telegram-managed-bot/setup" &&
					method === "GET"
				) {
					state.mode = url.searchParams.get("mode") ?? "waiting";
					state.confirmationAttempts = 0;
					state.pairAttempts = 0;
					state.requests = [];
					state.statusPolls = 0;
					sendJson(response, 200, { mode: state.mode, ready: true });
					return;
				}

				if (
					url.pathname === "/__fixture/telegram-managed-bot/snapshot" &&
					method === "GET"
				) {
					sendJson(response, 200, structuredClone(state));
					return;
				}

				if (
					url.pathname === "/api/channels/managed-bot/pair" &&
					method === "POST"
				) {
					const body = await readJson(request);
					state.pairAttempts += 1;
					recordRequest(state, request, url.pathname, body);

					if (state.mode === "pair-retry" && state.pairAttempts === 1) {
						sendJson(response, 503, {
							error: "The local pairing node is temporarily unavailable.",
						});
						return;
					}
					if (state.mode === "unsupported-pair") {
						sendJson(response, 501, {
							error: "managed_bots_unavailable",
							message: "Managed Telegram bots are disabled in this fixture.",
						});
						return;
					}

					const nonce = `telegram-nonce-${state.pairAttempts}`;
					const expiresAt =
						state.mode === "expired" && state.pairAttempts === 1
							? "2020-01-01T00:00:00.000Z"
							: new Date(Date.now() + 10 * 60_000).toISOString();
					const deepLink =
						state.mode === "invalid-link"
							? "https://outside.example.test/claim?nonce=public"
							: `https://t.me/ryu_managed_fixture_bot?start=mb_${nonce}`;
					sendJson(response, 201, {
						deep_link: deepLink,
						expires_at: expiresAt,
						nonce,
					});
					return;
				}

				const confirmMatch = url.pathname.match(
					/^\/api\/channels\/managed-bot\/([^/]+)\/confirm$/u
				);
				if (confirmMatch && method === "POST") {
					const body = await readJson(request);
					state.confirmationAttempts += 1;
					recordRequest(state, request, url.pathname, body);
					if (
						state.mode === "confirm-retry" &&
						state.confirmationAttempts === 1
					) {
						sendJson(response, 503, {
							error: "The local confirmation node is temporarily unavailable.",
						});
						return;
					}
					sendJson(response, 200, { status: "ready" });
					return;
				}

				const statusMatch = url.pathname.match(
					/^\/api\/channels\/managed-bot\/([^/]+)$/u
				);
				if (!statusMatch) {
					next();
					return;
				}

				if (method === "DELETE") {
					recordRequest(state, request, url.pathname, null);
					sendJson(response, 200, {
						manager_forgot: true,
						status: "cancelled",
					});
					return;
				}

				if (method === "GET") {
					state.statusPolls += 1;
					recordRequest(state, request, url.pathname, null);
					if (state.mode === "unsupported-status") {
						sendJson(response, 501, {
							error: "managed_bots_unavailable",
							message: "Managed Telegram bots are disabled in this fixture.",
						});
						return;
					}
					if (state.mode === "status-expired") {
						sendJson(response, 404, {
							message: "The local pairing nonce is unknown.",
						});
						return;
					}
					if (["connect", "not-mine", "confirm-retry"].includes(state.mode)) {
						sendJson(response, 200, botStatus());
						return;
					}
					if (state.mode === "ready-status") {
						sendJson(response, 200, {
							bot_id: 5_010_000_123,
							bot_username: "ryu_fixture_bot",
							channel_id: "fixture-channel-1",
							status: "ready",
							token: "fixture-telegram-token",
						});
						return;
					}
					sendJson(response, 200, { status: "waiting" });
					return;
				}

				sendJson(response, 405, { message: "Method not allowed." });
			});
		},
	};
}
