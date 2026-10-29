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
			className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-2.5 py-1.5"
			data-slot="agent-ui-surface-chip"
		>
			<span
				aria-hidden
				className={cn(
					"size-1.5 shrink-0 rounded-full",
					onScreen ? "bg-primary" : "bg-muted-foreground/40"
				)}
			/>
			<span className="min-w-0 flex-1 truncate text-foreground/80 text-xs">
				{label}
			</span>
			{onScreen ? (
				<span className="type-compact shrink-0 text-muted-foreground">
					On screen
				</span>
			) : (
				<button
					className="type-compact shrink-0 rounded-md px-1.5 py-0.5 text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
					onClick={() => host.open(surface)}
					type="button"
				>
					Show
				</button>
			)}
		</div>
	);
}
