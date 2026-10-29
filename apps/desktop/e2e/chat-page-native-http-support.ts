import { type APIRequestContext, expect } from "@playwright/test";
import type { Call } from "./chat-page-native-http.host.ts";
export const CHAT_PAGE_NATIVE_ORIGIN = "http://127.0.0.1:5590";
export const CHAT_PAGE_NATIVE_CORE_A = "http://127.0.0.1:5591";
export const CHAT_PAGE_NATIVE_CORE_B = "http://127.0.0.1:5594";
export const CHAT_PAGE_NATIVE_NODE_A_TOKEN = "chat-page-native-node-a-token";
export const CHAT_PAGE_NATIVE_NODE_B_TOKEN = "chat-page-native-node-b-token";
export async function chatPageControl(
	request: APIRequestContext,
	command: Record<string, unknown>
) {
	const response = await request.post(
		`${CHAT_PAGE_NATIVE_CORE_A}/__proof/control`,
		{
			headers: { "x-chat-page-proof-control": "owned-local-fixture" },
			data: command,
		}
	);
	expect(response.status()).toBe(200);
	return response.json();
}
export async function chatPageState(request: APIRequestContext): Promise<{
	scenario: string;
	calls: Call[];
	drafts: Record<string, unknown>[];
	unexpected: Array<{ reason: string; call: Call }>;
	heldRequestIds: number[];
	reversedEdits: unknown[];
	modelSelections: Record<string, unknown>;
	histories: Record<string, unknown[]>;
}> {
	const response = await request.get(
		`${CHAT_PAGE_NATIVE_CORE_A}/__proof/state`
	);
	expect(response.status()).toBe(200);
	return response.json();
}
