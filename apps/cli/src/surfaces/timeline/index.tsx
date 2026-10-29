/* @jsxImportSource @opentui/react */
// Timeline surface (path /timeline) - mirrors the desktop TimelinePage, which
// scrubs the Shadow capture lanes.
//
// The screen PREFERS the timeline app's own declarative view: an enabled plugin
// contributing a `views` entry with id "surface:timeline" claims this surface, and
// the shell renders that spec (src/ui/ContributedView.tsx) instead of the
// recorder-status card below. That is the only way this screen ever shows real
// capture data in a terminal, and until such a contribution exists the card stays.
//
// Shadow is a device-local sidecar (frame/keyframe data served off its own port, not
// Core's HTTP API), and the terminal has no
// pixel canvas to scrub, so this surface stays a clean status-aware empty-state: it
// probes the merged system status (GET /api/system/status) to report whether the
// Shadow sidecar is recording, mirroring the desktop's "Shadow is not running"
// affordance. Keys: r refreshes. Gated on being the focused pane's active tab.

import { useKeyboard } from "@opentui/react";
import { fetchSystemStatus } from "@ryuhq/core-client/system";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useSurfaceView } from "../../core/ContributionsContext.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { useInputFocused } from "../../core/InputFocusContext.tsx";
import { ContributedViewPanel } from "../../ui/ContributedView.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";

type ShadowState = "unknown" | "recording" | "stopped" | "unreachable";

const SHADOW_KEYS = ["shadow", "ghost"];

// The surface id — and therefore the `views` id an app declares to claim this
// screen, as the reserved `surface:<id>` token (see viewClaimingSurface in
// src/core/contributions.ts).
const SURFACE_ID = "timeline";

function TimelineSurface({ active, paneId }: SurfaceProps) {
	const { target } = useCore();
	const theme = useTheme();
	const { focusedPaneId } = useWorkspace();
	const focused = active && focusedPaneId === paneId;
	const inputFocused = useInputFocused();
	const contributed = useSurfaceView(SURFACE_ID);

	const [shadow, setShadow] = useState<ShadowState>("unknown");

	// Track the latest request so a stale resolve cannot clobber fresh data.
	const reqRef = useRef(0);

	const runLoad = useCallback(() => {
		const reqId = ++reqRef.current;
		fetchSystemStatus(target)
			.then((snap) => {
				if (reqRef.current !== reqId) {
					return;
				}
				const running = SHADOW_KEYS.some((key) => snap.sidecars[key]);
				setShadow(running ? "recording" : "stopped");
			})
			.catch(() => {
				if (reqRef.current !== reqId) {
					return;
				}
				setShadow("unreachable");
			});
	}, [target]);

	// Lazy load on activation, and reload on node switch (url/token). Skipped while
	// a contributed view owns the screen — the recorder probe is only there to feed
	// the built-in status card.
	useEffect(() => {
		if (active && !contributed) {
			runLoad();
		}
	}, [active, contributed, runLoad]);

	useKeyboard((key) => {
		if (!focused || contributed || inputFocused) {
			return;
		}
		if (key.name === "r") {
			runLoad();
		}
	});

	return (
		<box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1}>
			<box flexDirection="row" gap={2} paddingBottom={1}>
				<text fg={theme.colors.foreground}>
					<b>Timeline</b>
				</text>
				<text fg={theme.colors.mutedForeground}>
					{contributed ? "" : "activity history · r refresh"}
				</text>
			</box>
			{contributed ? (
				<ContributedViewPanel focused={focused} view={contributed} />
			) : (
				<TimelineBody shadow={shadow} />
			)}
		</box>
	);
}

function TimelineBody({ shadow }: { shadow: ShadowState }) {
	const theme = useTheme();
	if (shadow === "unreachable") {
		return (
			<Card title="Shadow">
				<text fg={theme.colors.error}>Core unreachable</text>
				<text fg={theme.colors.mutedForeground}>
					Could not reach the node to check the Shadow recorder.
				</text>
			</Card>
		);
	}
	if (shadow === "recording") {
		return (
			<Card
				borderColor={theme.colors.success}
				subtitle="recording"
				title="Shadow"
			>
				<text fg={theme.colors.foreground}>
					Shadow is capturing your activity on this device.
				</text>
				<text fg={theme.colors.mutedForeground}>
					The scrubbable capture lanes live in the desktop app; the terminal
					shows the recorder status only.
				</text>
			</Card>
		);
	}
	if (shadow === "stopped") {
		return (
			<Card title="Shadow">
				<text fg={theme.colors.warning}>Shadow is not running</text>
				<text fg={theme.colors.mutedForeground}>
					Start the Shadow sidecar to record your activity timeline.
				</text>
			</Card>
		);
	}
	return (
		<Card title="Shadow">
			<text fg={theme.colors.mutedForeground}>Checking recorder…</text>
		</Card>
	);
}

/** The Timeline surface module (path /timeline). Registered by the Integrate step. */
export const timelineSurface: SurfaceModule = {
	id: SURFACE_ID,
	title: "Timeline",
	match: (path) => path === "/timeline" || path.startsWith("/timeline/"),
	Component: TimelineSurface,
};
