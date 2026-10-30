import { useEffect, useState } from "react";
import { useApps } from "@/src/hooks/useApps.ts";
import { useBrowserOpenRequestStore } from "@/src/store/useBrowserOpenRequestStore.ts";
import { BROWSER_PLUGIN_ID } from "./browser-shared.ts";
import { BrowserSidecarPanel } from "./browser-sidecar-panel.tsx";
import { IframePanel } from "./iframe-panel.tsx";

// Feature-detected browser tab: when the `@ryu/browser` app is enabled, drive its
// real-Chromium sidecar through Core's ext-proxy. The frame is intentionally a
// screenshot-backed surface: it lets annotation mode freeze the exact pixels the
// user marked while the agent still controls the real embedded WebContentsView.
// When it is disabled, fall back to today's sandboxed IframePanel unchanged.
export function BrowserTabPanel({
	active = true,
	title,
}: {
	active?: boolean;
	title: string;
}) {
	const { apps } = useApps();
	const pendingOpen = useBrowserOpenRequestStore((state) => state.pending);
	const clearPendingOpen = useBrowserOpenRequestStore((state) => state.clear);
	const [consumedOpen, setConsumedOpen] = useState<{
		nonce: number;
		url: string;
	} | null>(null);
	useEffect(() => {
		if (!pendingOpen) {
			return;
		}
		setConsumedOpen(pendingOpen);
		clearPendingOpen();
	}, [clearPendingOpen, pendingOpen]);
	const requestedOpen = pendingOpen ?? consumedOpen;
	const enabled = apps.some((a) => a.id === BROWSER_PLUGIN_ID && a.enabled);
	if (enabled) {
		return (
			<BrowserSidecarPanel
				active={active}
				requestedNonce={requestedOpen?.nonce}
				requestedUrl={requestedOpen?.url}
			/>
		);
	}
	// Keyed by the request nonce so a repeated request for the same URL still
	// navigates the iframe again.
	return (
		<IframePanel
			initialUrl={requestedOpen?.url ?? "https://www.google.com"}
			key={requestedOpen?.nonce}
			title={title}
		/>
	);
}
