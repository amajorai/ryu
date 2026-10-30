// Surface-host seam for generative UI. A host that shows the agent's UI as one
// live screen (the Island) provides this context; the transcript then renders
// each `ui.render` call as a compact chip that points at, or reopens, that
// screen instead of drawing a second full copy inline. Without a provider (the
// desktop chat) every `ui.render` keeps rendering inline as before.

import { cn } from "@ryu/ui/lib/utils";
import { createContext, useContext } from "react";
import { type AgentUiSurface, agentUiSurfaceKey } from "./surface.ts";

export interface AgentUiSurfaceHost {
	/** {@link agentUiSurfaceKey} of the screen on display; `null` when none is. */
	activeKey: string | null;
	/** Bring `surface` back on screen (an older screen, or a dismissed one). */
	open: (surface: AgentUiSurface) => void;
}

const AgentUiSurfaceHostContext = createContext<AgentUiSurfaceHost | null>(
	null
);

export const AgentUiSurfaceHostProvider = AgentUiSurfaceHostContext.Provider;

export function useAgentUiSurfaceHost(): AgentUiSurfaceHost | null {
	return useContext(AgentUiSurfaceHostContext);
}

export function AgentUiSurfaceChip({
	host,
	surface,
}: {
	host: AgentUiSurfaceHost;
	surface: AgentUiSurface;
}) {
	const onScreen = host.activeKey === agentUiSurfaceKey(surface);
	const label = surface.title ?? "Generated screen";
	return (
		<div
			className="flex h-8 min-w-0 items-center gap-2 rounded-lg bg-muted px-2"
			data-slot="agent-ui-surface-chip"
		>
			<span
				aria-hidden
				className={cn(
					"size-1.5 shrink-0 rounded-full",
					onScreen ? "bg-primary" : "bg-muted-foreground"
				)}
			/>
			<span className="min-w-0 flex-1 truncate text-foreground text-xs">
				{label}
			</span>
			{onScreen ? (
				<span className="shrink-0 text-muted-foreground text-xs">
					On screen
				</span>
			) : (
				<button
					className="shrink-0 rounded-lg px-2 py-0.5 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
					onClick={() => host.open(surface)}
					type="button"
				>
					Show
				</button>
			)}
		</div>
	);
}
