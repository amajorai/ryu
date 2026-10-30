import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback } from "react";
import type {
	BrowserAnnotation,
	BrowserAnnotationInput,
	BrowserContextResult,
	BrowserRect,
} from "@/src/components/panels/BrowserAnnotationSurface.tsx";
import type { makeHeaders } from "@/src/lib/api/client.ts";
import type { useAssistantStore } from "@/src/store/useAssistantStore.ts";
import { formatBrowserContext } from "./browser-shared.ts";

type AssistantStore = ReturnType<typeof useAssistantStore.getState>;

interface BrowserAnnotationActionsInput {
	activeId: string | null;
	askRyuPendingRef: MutableRefObject<boolean>;
	call: (path: string, init?: RequestInit) => Promise<Response>;
	getContext: (
		id: string,
		selections?: BrowserRect[],
		includeScreenshot?: boolean
	) => Promise<BrowserContextResult>;
	headers: ReturnType<typeof makeHeaders>;
	isAnnotating: boolean;
	openAssistant: AssistantStore["open"];
	setAskRyuPending: Dispatch<SetStateAction<boolean>>;
	setContext: Dispatch<SetStateAction<BrowserContextResult | null>>;
	setError: Dispatch<SetStateAction<string | null>>;
	setIsAnnotating: Dispatch<SetStateAction<boolean>>;
	setIsFrozen: Dispatch<SetStateAction<boolean>>;
	setPendingPrompt: AssistantStore["setPendingPrompt"];
}

/**
 * The browser sidecar's annotation and "Ask Ryu" actions: freeze-and-annotate,
 * add, delete and clear annotations, and hand the annotated page to the global
 * assistant.
 */
export function useBrowserAnnotationActions({
	activeId,
	askRyuPendingRef,
	call,
	getContext,
	headers,
	isAnnotating,
	openAssistant,
	setAskRyuPending,
	setContext,
	setError,
	setIsAnnotating,
	setIsFrozen,
	setPendingPrompt,
}: BrowserAnnotationActionsInput) {
	const base = "/api/ext/@ryu/browser";
	const toggleAnnotating = useCallback(async () => {
		if (!activeId) {
			return;
		}
		if (isAnnotating) {
			setIsAnnotating(false);
			setIsFrozen(false);
			return;
		}
		setIsFrozen(true);
		try {
			await getContext(activeId, [], true);
			setIsAnnotating(true);
		} catch (e) {
			setIsAnnotating(false);
			setIsFrozen(false);
			setError(e instanceof Error ? e.message : "browser context failed");
		}
	}, [activeId, getContext, isAnnotating]);

	const annotate = useCallback(
		async (
			input: BrowserAnnotationInput
		): Promise<BrowserAnnotation | null> => {
			if (!activeId) {
				return null;
			}
			try {
				const resp = await call(
					`${base}/tabs/${encodeURIComponent(activeId)}/annotations`,
					{
						method: "POST",
						headers: { ...headers, "Content-Type": "application/json" },
						body: JSON.stringify(input),
					}
				);
				const annotation =
					/* SAFETY: The successful browser annotations publisher returns TabManager.annotate as BrowserAnnotation; call rejects errors first. */ (await resp.json()) as BrowserAnnotation;
				setError(null);
				setContext((current) =>
					current
						? { ...current, annotations: [...current.annotations, annotation] }
						: current
				);
				return annotation;
			} catch (e) {
				setError(e instanceof Error ? e.message : "annotation failed");
				return null;
			}
		},
		[activeId, call, headers]
	);

	const deleteAnnotation = useCallback(
		async (annotationId: string) => {
			if (!activeId) {
				return;
			}
			try {
				await call(
					`${base}/tabs/${encodeURIComponent(activeId)}/annotations/${encodeURIComponent(annotationId)}`,
					{ method: "DELETE" }
				);
				setError(null);
				setContext((current) =>
					current
						? {
								...current,
								annotations: current.annotations.filter(
									(annotation) => annotation.id !== annotationId
								),
							}
						: current
				);
			} catch (e) {
				setError(e instanceof Error ? e.message : "annotation delete failed");
			}
		},
		[activeId, call]
	);

	const clearAnnotations = useCallback(async () => {
		if (!activeId) {
			return;
		}
		try {
			await call(`${base}/tabs/${encodeURIComponent(activeId)}/annotations`, {
				method: "DELETE",
			});
			setError(null);
			setContext((current) =>
				current ? { ...current, annotations: [] } : current
			);
		} catch (e) {
			setError(e instanceof Error ? e.message : "annotation clear failed");
		}
	}, [activeId, call]);

	const askRyu = useCallback(async () => {
		if (!activeId || askRyuPendingRef.current) {
			return;
		}
		askRyuPendingRef.current = true;
		setAskRyuPending(true);
		try {
			const latest = await getContext(activeId, [], false);
			setPendingPrompt(
				`Review the embedded browser context and every saved annotation. Address each requested visual change in the live tab, using the browser context, snapshot, and control tools as needed.\n\n${formatBrowserContext(latest)}`
			);
			setError(null);
			openAssistant("sidebar");
		} catch (e) {
			setError(e instanceof Error ? e.message : "browser notes unavailable");
		} finally {
			askRyuPendingRef.current = false;
			setAskRyuPending(false);
		}
	}, [activeId, getContext, openAssistant, setPendingPrompt]);

	return {
		toggleAnnotating,
		annotate,
		deleteAnnotation,
		clearAnnotations,
		askRyu,
	};
}
