import { modelContextParts } from "@ryu/app-host/model-context";
import { DefaultChatTransport, type UIMessage } from "ai";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import type { useBuilderRuntime } from "@/src/hooks/useBuilderRuntime.ts";
import { chatHeaders, chatStreamUrl } from "@/src/lib/api/chat.ts";
import { type ApiTarget, accountJwtForTarget } from "@/src/lib/api/client.ts";
import type { AssistantBuilderSession } from "@/src/store/useAssistantStore.ts";
import { buildChatRequestBody } from "./AssistantPanel-request.ts";

type BuilderRuntime = ReturnType<typeof useBuilderRuntime>;

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

	const transport = useMemo(
		() =>
			new DefaultChatTransport<UIMessage>({
				api: chatStreamUrl(chatTarget),
				headers: async (): Promise<Record<string, string>> => {
					const base = chatHeaders(chatTarget);
					const jwt = await accountJwtForTarget(chatTarget);
					return jwt ? { ...base, "X-Ryu-User-Jwt": jwt } : base;
				},
				prepareSendMessagesRequest: ({ messages: outgoingMessages }) => {
					const context = modelContextParts("assistant");
					let latestUser = -1;
					for (const [index, message] of outgoingMessages.entries()) {
						if (message.role === "user") {
							latestUser = index;
						}
					}
					return buildChatRequestBody({
						outgoing: outgoingMessages.map((message, index) =>
							index === latestUser && context.length > 0
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
