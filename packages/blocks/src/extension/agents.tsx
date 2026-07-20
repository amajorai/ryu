"use client";

import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { Bot, Lock } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Block-local agent shape: the subset of fields the card renders. The live
 * extension's `AgentRecord` (which also carries chat-model objects, policy
 * refs, etc.) is resolved down to this by the glue before it reaches the card.
 */
export interface AgentCardData {
	builtIn?: boolean;
	description?: string | null;
	engine?: string | null;
	hasPolicy?: boolean;
	id: string;
	model?: string | null;
	name: string;
	toolCount?: number;
}

export function AgentCard({ agent }: { agent: AgentCardData }) {
	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2 text-base">
					<Bot className="size-4 opacity-70" />
					{agent.name}
				</CardTitle>
				<CardDescription className="flex flex-wrap items-center gap-1.5">
					<Badge variant="secondary">{agent.engine ?? "unbound"}</Badge>
					{agent.model ? <Badge variant="outline">{agent.model}</Badge> : null}
					{agent.toolCount ? (
						<Badge variant="outline">
							{agent.toolCount} tool{agent.toolCount === 1 ? "" : "s"}
						</Badge>
					) : null}
					{agent.hasPolicy ? (
						<Badge className="gap-1" variant="outline">
							<Lock className="size-3" />
							Policy
						</Badge>
					) : null}
					{agent.builtIn ? (
						<Badge className="gap-1" variant="outline">
							<Lock className="size-3" />
							Built-in
						</Badge>
					) : null}
				</CardDescription>
				{agent.description ? (
					<p className="mt-1 line-clamp-2 text-muted-foreground text-xs">
						{agent.description}
					</p>
				) : null}
			</CardHeader>
		</Card>
	);
}

export type AgentsGridState = "ready" | "loading" | "empty" | "error";

export interface AgentsGridProps {
	agents?: AgentCardData[];
	/** Optional CTA slot for empty/error states (live extension wires the action). */
	emptyAction?: ReactNode;
	errorAction?: ReactNode;
	errorMessage?: string;
	state?: AgentsGridState;
}

const SKELETON_KEYS = ["a", "b", "c", "d"] as const;

/**
 * The dashboard Agents grid, presentational. Every browser-backed input (the
 * agent list, the load state, the retry handler) is an optional prop so the
 * block renders standalone while the live extension injects Core data.
 */
export function AgentsGrid({
	agents = [],
	state = "ready",
	errorMessage = "The Core node is unreachable. Check that the node is running.",
	emptyAction,
	errorAction,
}: AgentsGridProps) {
	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="px-6 pt-6 pb-2">
				<h1 className="font-semibold text-xl">Agents</h1>
				<p className="mt-0.5 text-muted-foreground text-sm">
					Your installed agents, each a swappable card.
				</p>
			</div>
			<div className="flex-1 overflow-y-auto px-6 pb-6">
				{state === "loading" ? (
					<div className="grid grid-cols-2 gap-4">
						{SKELETON_KEYS.map((key) => (
							<div
								className="h-28 animate-pulse rounded-xl border border-border bg-muted/40"
								key={key}
							/>
						))}
					</div>
				) : null}

				{state === "empty" ? (
					<div className="flex h-full flex-col items-center justify-center gap-3 text-center">
						<span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
							<Bot className="size-6" />
						</span>
						<div className="space-y-1">
							<h2 className="font-semibold text-base">No agents yet</h2>
							<p className="max-w-xs text-muted-foreground text-sm">
								Only the built-in Ryu agent ships by default. Install more from
								the catalog.
							</p>
						</div>
						{emptyAction ?? <Button size="sm">Browse the catalog</Button>}
					</div>
				) : null}

				{state === "error" ? (
					<div className="flex h-full flex-col items-center justify-center gap-3 text-center">
						<span className="flex size-12 items-center justify-center rounded-2xl bg-destructive/10 text-2xl text-destructive">
							!
						</span>
						<div className="space-y-1">
							<h2 className="font-semibold text-base">Could not load agents</h2>
							<p className="max-w-xs text-muted-foreground text-sm">
								{errorMessage}
							</p>
						</div>
						{errorAction ?? (
							<Button size="sm" variant="outline">
								Retry
							</Button>
						)}
					</div>
				) : null}

				{state === "ready" ? (
					<div className="grid grid-cols-2 gap-4">
						{agents.map((agent) => (
							<AgentCard agent={agent} key={agent.id} />
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}
