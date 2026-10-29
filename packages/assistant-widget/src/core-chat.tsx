"use client";

import { useChat } from "@ai-sdk/react";
import type { JSONValue, UIMessage } from "ai";
import { DefaultChatTransport } from "ai";
import { useMemo, useState } from "react";
import { z } from "zod";
import type { RyuAssistantChatProps } from "./chat.tsx";
import { RyuAssistantChat } from "./chat.tsx";

export interface RyuAssistantCoreTarget {
	token?: string | null;
	url: string;
}

/**
 * Ready-to-run Core-backed assistant. This is the no-custom-transport path: pass
 * a node target and the widget owns the AI SDK chat loop while still exposing the
 * same Ryu Assistant surface. The token stays in the browser memory of the host.
 */
export interface RyuAssistantCoreChatProps
	extends Omit<
		RyuAssistantChatProps,
		"error" | "messages" | "onSend" | "onStop" | "status"
	> {
	agentId?: string;
	conversationId?: string;
	requestBody?: Record<string, JSONValue>;
	responseMode?: string;
	target: RyuAssistantCoreTarget;
}

const TRAILING_SLASHES = /\/+$/;
const cancelResponseSchema = z.object({ cancelled: z.boolean() });

function coreApiUrl(target: RyuAssistantCoreTarget, path: string): string {
	return `${target.url.replace(TRAILING_SLASHES, "")}${path}`;
}

function coreChatUrl(target: RyuAssistantCoreTarget): string {
	return coreApiUrl(target, "/api/chat/stream");
}

/**
 * Ask Core to stop a conversation's in-flight turn. Core drives a saved turn
 * independently of the request that started it, so aborting the stream alone
 * would leave it generating. Best-effort: resolves `false` when nothing was
 * running or Core could not be reached.
 */
export async function cancelCoreChatTurn(
	target: RyuAssistantCoreTarget,
	conversationId: string
): Promise<boolean> {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (target.token) {
		headers.set("Authorization", `Bearer ${target.token}`);
	}
	try {
		const response = await fetch(coreApiUrl(target, "/api/chat/cancel"), {
			body: JSON.stringify({ conversation_id: conversationId }),
			headers,
			method: "POST",
		});
		if (!response.ok) {
			return false;
		}
		const parsed = cancelResponseSchema.safeParse(await response.json());
		return parsed.success && parsed.data.cancelled;
	} catch {
		return false;
	}
}

export function RyuAssistantCoreChat({
	agentId = "ryu",
	conversationId,
	requestBody,
	responseMode = "work",
	target,
	...surfaceProps
}: RyuAssistantCoreChatProps) {
	const [generatedConversationId] = useState(
		() => `assistant-widget-${crypto.randomUUID()}`
	);
	const chatId = conversationId ?? generatedConversationId;
	const transport = useMemo(
		() =>
			new DefaultChatTransport<UIMessage>({
				api: coreChatUrl(target),
				body: () => ({
					...requestBody,
					agent_id: agentId,
					conversation_id: chatId,
					enable_long_term: false,
					response_mode: responseMode,
				}),
				headers: () => {
					const headers = new Headers();
					if (target.token) {
						headers.set("Authorization", `Bearer ${target.token}`);
					}
					return headers;
				},
			}),
		[target.token, target.url, agentId, chatId, requestBody, responseMode]
	);
	const { error, messages, sendMessage, status, stop } = useChat({
		id: chatId,
		transport,
	});

	return (
		<RyuAssistantChat
			{...surfaceProps}
			error={error ?? undefined}
			messages={messages}
			onSend={(message) => {
				void sendMessage({ text: message.content });
			}}
			onStop={() => {
				void stop();
				void cancelCoreChatTurn(target, chatId);
			}}
			status={status}
		/>
	);
}
