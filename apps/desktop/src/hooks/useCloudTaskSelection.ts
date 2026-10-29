import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { type ApiTarget, request } from "@/src/lib/api/client.ts";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
import {
	type CloudTaskSelection,
	cloudTaskScope,
	LOADING_CLOUD_SELECTION,
	LOCAL_CLOUD_SELECTION,
	runtimeFromBinding,
	useCloudTaskSelections,
} from "@/src/lib/cloud-task-selection.ts";

export function useCloudTaskSelection(
	target: ApiTarget,
	conversationId: string,
	existing: boolean
) {
	const [scope, setScope] = useState<string | null>(null);
	const [retry, setRetry] = useState(0);
	const [initializationError, setInitializationError] = useState<string | null>(
		null
	);
	const selections = useCloudTaskSelections((state) => state.selections);
	const cloudIntent = useRef(false);
	const scopeContext = useRef<{
		target: ApiTarget;
		conversationId: string;
	} | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		// A draft chat turns into a stored conversation under the SAME id when its
		// first message is sent, which flips `existing` and re-runs this effect.
		// Do not clear `scope` here: it hashes only the target and that id, so the
		// selection already resolved for them is still this chat's, and clearing it
		// read "loading" while the first request was starting (the transport
		// refuses to send a turn while the selection is loading). A different chat
		// needs no clearing either: what is returned is gated on `contextMatches`,
		// which compares the resolved target and conversation id with the current
		// ones, so a stale `scope` is never lent out.
		setInitializationError(null);
		async function load() {
			const next = await cloudTaskScope(target, conversationId);
			if (controller.signal.aborted) {
				return;
			}
			setScope(next);
			scopeContext.current = { target, conversationId };
			const state = useCloudTaskSelections.getState();
			const previous = state.selections[next];
			if (
				previous &&
				(previous.mode === "cloud" || previous.mode === "local")
			) {
				if (existing && !previous.locked) {
					state.setSelection(next, { ...previous, locked: true });
				}
				return;
			}
			if (!existing) {
				state.setSelection(
					next,
					cloudIntent.current
						? {
								mode: "cloud",
								environmentId: null,
								runtime: null,
								locked: false,
							}
						: LOCAL_CLOUD_SELECTION
				);
				return;
			}
			state.setSelection(next, LOADING_CLOUD_SELECTION);
			try {
				const binding = await request<unknown>(
					target,
					`/api/cloud-environments/task-binding/${encodeURIComponent(conversationId)}`,
					{ signal: controller.signal },
					gatewayJsonValueSchema
				);
				// Older Core omits backend/executor; when present they must be text or null.
				const parsedBinding = z
					.object({
						backend: z.string().nullish(),
						cloudEnvironmentId: z.string().nullable(),
						executor: z.string().nullish(),
					})
					.parse(binding);
				if (controller.signal.aborted) {
					return;
				}
				state.setSelection(
					next,
					parsedBinding.cloudEnvironmentId
						? {
								mode: "cloud",
								environmentId: parsedBinding.cloudEnvironmentId,
								runtime: runtimeFromBinding(
									parsedBinding.backend ?? null,
									parsedBinding.executor ?? null
								),
								locked: true,
							}
						: { mode: "local", locked: true }
				);
			} catch (error) {
				if (!controller.signal.aborted) {
					state.setSelection(next, {
						mode: "error",
						message:
							error instanceof Error
								? error.message
								: "Could not load this chat's cloud binding",
					});
				}
			}
		}
		load().catch((error) => {
			if (!controller.signal.aborted) {
				setInitializationError(
					error instanceof Error
						? error.message
						: "Could not initialize cloud task selection"
				);
			}
		});
		return () => controller.abort();
	}, [
		target.url,
		target.token,
		target.userJwt,
		conversationId,
		existing,
		retry,
	]);
	const contextMatches =
		scopeContext.current?.target.url === target.url &&
		scopeContext.current.target.token === target.token &&
		scopeContext.current.target.userJwt === target.userJwt &&
		scopeContext.current.conversationId === conversationId;
	const selection: CloudTaskSelection =
		scope && contextMatches
			? (selections[scope] ?? LOADING_CLOUD_SELECTION)
			: initializationError
				? { mode: "error", message: initializationError }
				: LOADING_CLOUD_SELECTION;
	if (selection.mode === "cloud") {
		cloudIntent.current = true;
	}
	if (selection.mode === "local") {
		cloudIntent.current = false;
	}
	return {
		scope: contextMatches ? scope : null,
		selection,
		retry: () => setRetry((value) => value + 1),
	};
}
