import type { UIMessage } from "ai";
import { useCallback, useMemo, useRef, useState } from "react";
import {
	type ActivePermission,
	activePermissionSchema,
	PermissionPrompt,
} from "@/src/components/chat/PermissionPrompt.tsx";
import type { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import { respondPermission } from "@/src/lib/api/acp.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { useAssistantStore } from "@/src/store/useAssistantStore.ts";

/**
 * Scan messages (newest first) for the latest still-unresolved tool-permission
 * request an agent emitted (a `data-ryu-permission` part) — how the agent builder
 * gates `agent_builder.configure_agent`. Top-level to keep the panel lean.
 */
function findActivePermission(
	messages: UIMessage[],
	resolved: Set<string>
): ActivePermission | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant" || !message.parts) {
			continue;
		}
		for (let j = message.parts.length - 1; j >= 0; j--) {
			const part = message.parts[j];
			if (part.type !== "data-ryu-permission") {
				continue;
			}
			const parsed = activePermissionSchema.safeParse(part.data);
			const data = parsed.success ? parsed.data : undefined;
			if (data?.requestId && !resolved.has(data.requestId)) {
				return data;
			}
		}
	}
	return null;
}

/** The tool-permission prompt for the panel's composer (see the comment below). */
export function useAssistantPermission({
	activeConvId,
	chatTarget,
	interfaceLevel,
	messages,
}: {
	activeConvId: string;
	chatTarget: ApiTarget;
	interfaceLevel: ReturnType<typeof useInterfaceLevel>;
	messages: UIMessage[];
}) {
	// Active tool-permission prompt (Zed-style allow/deny) — passed into the
	// shared composer surface whenever the agent builder gates
	// `agent_builder.configure_agent`. It is also available in generic chat.
	const permissionScope = JSON.stringify([
		activeConvId,
		chatTarget.url,
		chatTarget.token,
		chatTarget.userJwt,
	]);
	const permissionScopeRef = useRef(permissionScope);
	permissionScopeRef.current = permissionScope;
	const resolvedInScope = useAssistantStore(
		(s) => s.resolvedPermissions[permissionScope]
	);
	const markPermissionResolved = useAssistantStore(
		(s) => s.markPermissionResolved
	);
	const activePermission = useMemo(
		() => findActivePermission(messages, new Set(resolvedInScope)),
		[messages, resolvedInScope]
	);
	const respondingPermissions = useRef(new Set<string>());
	const [permissionError, setPermissionError] = useState<{
		key: string;
		message: string;
	} | null>(null);
	const [permissionPending, setPermissionPending] = useState<Set<string>>(
		() => new Set()
	);
	const activePermissionKey = JSON.stringify([
		permissionScope,
		activePermission?.requestId,
	]);
	const handleRespondPermission = useCallback(
		(optionId: string | null) => {
			const requestId = activePermission?.requestId;
			const key = JSON.stringify([permissionScope, requestId]);
			if (!requestId || respondingPermissions.current.has(key)) {
				return;
			}
			respondingPermissions.current.add(key);
			setPermissionPending((previous) => new Set([...previous, key]));
			setPermissionError(null);
			void respondPermission(chatTarget, requestId, optionId)
				// Kept in the store, so it holds after the panel closes or the
				// surface thread switches; a reply that lands after the auth scope
				// moved is stale and resolves nothing.
				.then(() => {
					if (permissionScopeRef.current !== permissionScope) {
						return;
					}
					markPermissionResolved(permissionScope, requestId);
				})
				.catch(() => {
					if (permissionScopeRef.current !== permissionScope) {
						return;
					}
					setPermissionError({
						key,
						message: "Could not send your permission response. Try again.",
					});
				})
				.finally(() => {
					respondingPermissions.current.delete(key);
					setPermissionPending((previous) => {
						const next = new Set(previous);
						next.delete(key);
						return next;
					});
				});
		},
		[activePermission, chatTarget, markPermissionResolved, permissionScope]
	);
	const permissionComposerPrompt = useMemo(
		() =>
			activePermission
				? {
						content: (
							<fieldset
								className="min-w-0 border-0 p-0"
								disabled={permissionPending.has(activePermissionKey)}
							>
								<PermissionPrompt
									embedded
									onRespond={handleRespondPermission}
									permission={activePermission}
									showTechnicalDetails={interfaceLevel !== "simple"}
								/>
								{permissionError?.key === activePermissionKey ? (
									<p
										className="px-3 pb-2 text-destructive text-xs"
										role="alert"
									>
										{permissionError.message}
									</p>
								) : null}
							</fieldset>
						),
						id: `permission:${activePermission.requestId}`,
					}
				: undefined,
		[
			activePermission,
			activePermissionKey,
			handleRespondPermission,
			interfaceLevel,
			permissionError,
			permissionPending,
		]
	);
	return permissionComposerPrompt;
}
