/* @jsxImportSource @opentui/react */
// Shared loading state. A tab that is fetching renders <Loading label="..." /> in
// its content area. Uses termcn's StatusMessage loading variant (animated spinner)
// so every tab's loading state looks identical.

import { StatusMessage } from "@/components/ui/status-message.tsx";

export function Loading({ label = "Loading…" }: { label?: string }) {
	return (
		<box paddingLeft={1} paddingTop={1}>
			<StatusMessage variant="loading">{label}</StatusMessage>
		</box>
	);
}
