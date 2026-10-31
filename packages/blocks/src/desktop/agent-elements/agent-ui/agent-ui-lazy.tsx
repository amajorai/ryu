"use client";

import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { preloadableLazy } from "@ryu/ui/lib/preloadable-lazy.tsx";
import type { ComponentProps, ReactNode } from "react";
import type { AgentUI } from "./agent-ui.tsx";

type AgentUIProps = ComponentProps<typeof AgentUI>;

// Generative UI pulls in json-render and the full chart/control registry
// (recharts among it). Most turns never render one, so it loads at the first
// `ui.render`. It is not warmed in idle time, so sessions that never render
// one never parse recharts.
const agentUi = preloadableLazy<AgentUIProps>(() =>
	import("./agent-ui.tsx").then((module) => module.AgentUI)
);

/** Start fetching the generative-UI renderer without rendering it. */
export function preloadAgentUI(): Promise<void> {
	return agentUi.preload();
}

export function LazyAgentUI({
	fallback,
	...props
}: AgentUIProps & {
	/** Shown while the renderer loads; a card-sized skeleton by default. */
	fallback?: ReactNode;
}) {
	return (
		<agentUi.Render
			{...props}
			fallback={fallback ?? <Skeleton className="h-24 w-full" radius="panel" />}
		/>
	);
}
