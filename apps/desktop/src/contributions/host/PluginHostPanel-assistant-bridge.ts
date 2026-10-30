import { useModelContextStore } from "@ryu/app-host/model-context";
import { useEffect, useRef } from "react";
import { useIsActiveTab } from "@/src/contexts/TabsContext.tsx";
import {
	type AssistantBuilderSession,
	type PageContextItem,
	useAssistantStore,
} from "@/src/store/useAssistantStore.ts";

/** Hold this app's assistant context and takeover only while its tab is focused. */
export function usePluginAssistantBridge(assistantOwner: string) {
	// What this app last asked the assistant to hold. The store only carries it
	// while this panel's tab is focused: inactive tabs stay mounted (hidden), and
	// a background app must not keep its context or takeover on whatever page the
	// user is now looking at. Focus returning re-applies the app's last state.
	const isActiveTab = useIsActiveTab();
	const isActiveTabRef = useRef(isActiveTab);
	isActiveTabRef.current = isActiveTab;
	const assistantContextRef = useRef<PageContextItem[]>([]);
	const assistantSurfaceRef = useRef<AssistantBuilderSession | null>(null);
	// A new frame document (retry/reload changes the nonce, and so the owner) has
	// published nothing yet: forget the previous document's context and surface
	// so they are never replayed under the new owner. Declared before the focus
	// effect below so it runs first.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset at the owner boundary
	useEffect(() => {
		assistantContextRef.current = [];
		assistantSurfaceRef.current = null;
	}, [assistantOwner]);
	useEffect(() => {
		const assistant = useAssistantStore.getState();
		if (!isActiveTab) {
			assistant.clearContextOwner(assistantOwner);
			assistant.clearBuilder(assistantOwner);
			return;
		}
		if (assistantContextRef.current.length > 0) {
			assistant.publishContext(assistantOwner, assistantContextRef.current);
		}
		if (assistantSurfaceRef.current) {
			assistant.registerBuilder(assistantSurfaceRef.current);
		}
	}, [isActiveTab, assistantOwner]);

	// A closed page is not "what the user is looking at". Drop this app's slice and
	// its takeover when the panel unmounts — an app that crashed or was navigated
	// away from must not keep steering the assistant.
	useEffect(() => {
		return () => {
			const assistant = useAssistantStore.getState();
			useModelContextStore.getState().clear(assistantOwner);
			assistant.clearContextOwner(assistantOwner);
			assistant.clearBuilder(assistantOwner);
		};
	}, [assistantOwner]);
	return { assistantContextRef, assistantSurfaceRef, isActiveTabRef };
}
