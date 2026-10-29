import { SseFrameDecoder } from "@ryuhq/protocol/sse";
import {
	GUEST_CHAT_PATH,
	guestChatErrorSchema,
	guestChatStatusSchema,
	guestChatStreamSchema,
} from "./guest-contract.ts";

const MAX_ASSISTANT_CHARS = 12_000;
const GENERIC_GUEST_ERROR = "Guest chat could not answer this request.";

function parseChunkContent(data: string): string | "done" | null {
	if (data === "[DONE]") {
		return "done";
	}
	let parsed: ReturnType<typeof guestChatStreamSchema.safeParse>;
	try {
		parsed = guestChatStreamSchema.safeParse(JSON.parse(data));
	} catch {
		return null;
	}
	if (!parsed.success) {
		return null;
	}
	if (parsed.data.error) {
		throw new Error(parsed.data.error.message ?? GENERIC_GUEST_ERROR);
	}
	return parsed.data.choices?.[0]?.delta?.content ?? null;
}

async function responseError(response: Response): Promise<Error> {
	let message = GENERIC_GUEST_ERROR;
	try {
		const body = guestChatErrorSchema.safeParse(await response.json());
		if (body.success && body.data.error.message !== undefined) {
			message = body.data.error.message.slice(0, 500);
		}
	} catch {
		// Keep the generic message when the response is not JSON.
	}
	return new Error(message);
}

/**
 * Whether the host site has a guest chat lane. False on any failure, so the
 * widget never offers a mode that cannot answer.
 */
export async function fetchGuestChatAvailable(
	signal?: AbortSignal
): Promise<boolean> {
	try {
		const response = await fetch(GUEST_CHAT_PATH, {
			cache: "no-store",
			credentials: "omit",
			signal,
		});
		if (!response.ok) {
			return false;
		}
		return (
			guestChatStatusSchema.safeParse(await response.json()).data?.available ??
			false
		);
	} catch {
		return false;
	}
}

/**
 * Send one guest turn through the host's same-origin route, which forwards it
 * to Ryu's screened hosted Gateway, and stream its answer.
 */
export async function runGuestChat(
	question: string,
	options: {
		onDelta?: (text: string) => void;
		signal?: AbortSignal;
	} = {}
): Promise<string> {
	const response = await fetch(GUEST_CHAT_PATH, {
		body: JSON.stringify({ question }),
		cache: "no-store",
		credentials: "omit",
		headers: { "Content-Type": "application/json" },
		method: "POST",
		signal: options.signal,
	});
	if (!(response.ok && response.body)) {
		throw await responseError(response);
	}

	const reader = response.body.getReader();
	// Bounded frame decoder: an unterminated or oversized event cancels the
	// stream instead of growing a buffer without limit.
	const decoder = new SseFrameDecoder();
	let answer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				decoder.finish();
				break;
			}
			for (const frame of decoder.push(value)) {
				const data = frame
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice("data:".length).trim())
					.join("\n");
				if (data) {
					const content = parseChunkContent(data);
					if (content === "done") {
						return answer;
					}
					if (content && answer.length < MAX_ASSISTANT_CHARS) {
						const delta = content.slice(0, MAX_ASSISTANT_CHARS - answer.length);
						answer += delta;
						options.onDelta?.(delta);
					}
				}
			}
		}
	} finally {
		decoder.finish();
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	return answer;
}
