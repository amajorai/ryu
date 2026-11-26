import {
	modelContextParts,
	useModelContextStore,
} from "@ryu/app-host/model-context";
import { DefaultChatTransport, type UIMessage } from "ai";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import type { useBuilderRuntime } from "@/src/hooks/useBuilderRuntime.ts";
import { chatHeaders, chatStreamUrl } from "@/src/lib/api/chat.ts";
import { type ApiTarget, accountJwtForTarget } from "@/src/lib/api/client.ts";
import type { AssistantBuilderSession } from "@/src/store/useAssistantStore.ts";
import { buildChatRequestBody } from "./AssistantPanel-request.ts";
import { escapeContextDelimiters } from "./assistant-message-display.ts";

type BuilderRuntime = ReturnType<typeof useBuilderRuntime>;

/** Owner key to update id of the app context entries one request carries. */
type SentAppContext = Record<string, string>;

function assistantAppContextReceipt(): SentAppContext {
	return Object.fromEntries(
		Object.entries(useModelContextStore.getState().entries)
			.filter(([, entry]) => entry.scope === "assistant")
			.map(([owner, entry]) => [owner, entry.state.updateId])
	);
}

/** App context lives for one turn: drop each entry the accepted request
 *  carried, unless its app published something newer in the meantime. */
function dropSentAppContext(sent: SentAppContext) {
	const store = useModelContextStore.getState();
	for (const [owner, updateId] of Object.entries(sent)) {
		if (store.get("assistant", owner)?.updateId === updateId) {
			store.clear(owner);
		}
	}
}

/** The panel's chat transport plus the live builder refs it reads at send time. */
export function useAssistantTransport({
	activeConvIdRef,
	builder,
	builderRuntime,
	chatTarget,
	convIdRef,
	genericRuntime,
}: {
	activeConvIdRef: RefObject<string>;
	builder: AssistantBuilderSession | null;
	builderRuntime: BuilderRuntime;
	chatTarget: ApiTarget;
	convIdRef: RefObject<string>;
	genericRuntime: BuilderRuntime;
}) {
	// Live builder state the transport/effects read at send time. `targetIdRef` is
	// set synchronously in `handleSend` right after `resolveId` so the preamble
	// sees the resolved id before the request is built (the new-record chicken-and-
	// egg the old builder panes handled the same way).
	const builderRef = useRef(builder);
	builderRef.current = builder;
	const targetIdRef = useRef<string | null>(builder?.targetId ?? null);
	useEffect(() => {
		if (builder?.targetId) {
			targetIdRef.current = builder.targetId;
		}
	}, [builder?.targetId]);
	// Stable-identity body-field closures for each runtime (both are stable, but
	// the refs keep the transport memo from depending on them).
	const genericBodyFieldsRef = useRef(genericRuntime.bodyFields);
	genericBodyFieldsRef.current = genericRuntime.bodyFields;
	const builderBodyFieldsRef = useRef(builderRuntime.bodyFields);
	builderBodyFieldsRef.current = builderRuntime.bodyFields;
	// What the request being sent carries from apps, taken by `fetch` below.
	const sentAppContextRef = useRef<SentAppContext>({});

	const transport = useMemo(
		() =>
			new DefaultChatTransport<UIMessage>({
				api: chatStreamUrl(chatTarget),
				headers: async (): Promise<Record<string, string>> => {
					const base = chatHeaders(chatTarget);
					const jwt = await accountJwtForTarget(chatTarget);
					return jwt ? { ...base, "X-Ryu-User-Jwt": jwt } : base;
				},
				// A send the node accepted (2xx) ends the life of the app context it
				// carried. A refused or failed request keeps it for the retry.
				fetch: Object.assign(
					async (input: RequestInfo | URL, init?: RequestInit) => {
						// Only the send itself (POST) takes the receipt, a stream
						// reconnect (GET) carries no app context.
						const isSend = init?.method === "POST";
						const sent: SentAppContext = isSend
							? sentAppContextRef.current
							: {};
						if (isSend) {
							sentAppContextRef.current = {};
						}
						const response = await fetch(input, init);
						if (response.ok) {
							dropSentAppContext(sent);
						}
						return response;
					},
					// Bun's fetch type carries preconnect; DOM-only builds do not declare it.
					{ preconnect: Reflect.get(fetch, "preconnect") }
				),
				prepareSendMessagesRequest: ({ messages: outgoingMessages }) => {
					// App text rides the person's own message, so each app's block is
					// named by the shell, put under an untrusted-data notice, capped and
					// escaped the same way as page context.
					const context = modelContextParts("assistant", undefined, {
						escape: escapeContextDelimiters,
					});
					let latestUser = -1;
					for (const [index, message] of outgoingMessages.entries()) {
						if (message.role === "user") {
							latestUser = index;
						}
					}
					const carried = latestUser >= 0 && context.length > 0;
					sentAppContextRef.current = carried
						? assistantAppContextReceipt()
						: {};
					return buildChatRequestBody({
						outgoing: outgoingMessages.map((message, index) =>
							index === latestUser && carried
								? { ...message, parts: [...message.parts, ...context] }
								: message
						),
						session: builderRef.current,
						sessionConvId: activeConvIdRef.current,
						targetId: targetIdRef.current,
						builderBodyFields: builderBodyFieldsRef.current,
						genericBodyFields: genericBodyFieldsRef.current,
						convId: convIdRef.current,
					});
				},
			}),
		[chatTarget]
	);
	return { builderRef, targetIdRef, transport };
}
