import { Button } from "@ryu/ui/components/button.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppDisabledNotice } from "../../src/components/AppDisabledNotice.tsx";
import { useApps } from "../../src/hooks/useApps.ts";
import { useMeetingStream } from "../../src/hooks/useMeetingStream.ts";
import { useEnabledApps } from "../../src/lib/gating/useEnabledApps.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import { useMeetingRecordingStore } from "../../src/store/useMeetingRecordingStore.ts";
import { type Node, useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";
const node: Node = {
	name: "App fixture",
	url: location.origin,
	token: null,
	userJwt: null,
};
const select = (userJwt: string | null) =>
	useNodeStore.setState({
		nodes: [{ ...node, userJwt }],
		localNodes: [{ ...node, userJwt }],
		defaultNode: node.name,
		autoSelect: false,
	});
select(null);
queryClient.setDefaultOptions({
	queries: { retry: false, refetchOnWindowFocus: false },
});
function Runtime() {
	const roster = useApps();
	const enabled = useEnabledApps();
	useMeetingStream();
	const recording = useMeetingRecordingStore((state) => state.active);
	return (
		<>
			<p data-testid="recording-state">
				{recording ? "Meeting state: recording" : "Meeting state: idle"}
			</p>
			<div className="mt-6">
				<Button onClick={() => void roster.toggle("@ryu/meetings", false)}>
					Disable Meetings
				</Button>
			</div>
			{enabled === undefined ? (
				<p role="status">Apps unavailable</p>
			) : enabled.has("@ryu/meetings") ? (
				<p role="status">Meetings enabled</p>
			) : (
				<AppDisabledNotice
					app="@ryu/meetings"
					message="Enable the Meetings app"
				/>
			)}
		</>
	);
}
function Story() {
	const [mounted, setMounted] = useState(true);
	const [enabledRefreshes, setEnabledRefreshes] = useState(0);
	const noticeOnly =
		new URLSearchParams(window.location.search).get("notice-only") === "1";
	return (
		<QueryClientProvider client={queryClient}>
			<main className="min-h-screen bg-background p-8 text-foreground">
				{noticeOnly ? (
					<>
						<p data-testid="enabled-refreshes">{enabledRefreshes}</p>
						<AppDisabledNotice
							app="@ryu/meetings"
							message="Enable the Meetings app"
							onEnabled={() => setEnabledRefreshes((count) => count + 1)}
						/>
					</>
				) : (
					<>
						<div className="flex gap-2">
							<Button onClick={() => select("second-fixture")}>
								Rotate identity
							</Button>
							<Button onClick={() => setMounted(false)}>Unmount runtime</Button>
						</div>
						{mounted ? <Runtime /> : <p>Runtime closed</p>}
					</>
				)}
			</main>
			<Toaster position="bottom-right" theme="light" />
		</QueryClientProvider>
	);
}
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
