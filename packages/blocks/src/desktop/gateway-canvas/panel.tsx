"use client";

// The click-to-edit panel (spec 07.6): the selected node's header, its live
// counters and the host's editor for it. The host renders the same policy
// forms and guardrail cards it shows elsewhere, so a save from the canvas
// goes through the same API and shows the same conflict notice.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import type { CanvasLiveStore } from "./live-store.ts";
import {
	type CanvasNode,
	carriesRequests,
	formatCount,
	HEALTH_LABELS,
	NODE_KIND_LABELS,
} from "./model.ts";
import { HealthDot, KIND_ICON, useNodeCounters } from "./nodes.tsx";

function usdFromMicro(micro: number): string {
	return `$${(micro / 1_000_000).toFixed(micro < 10_000 ? 4 : 2)}`;
}

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex min-w-0 flex-col">
			<dt className="text-[11px] text-muted-foreground">{label}</dt>
			<dd className="truncate font-medium text-sm tabular-nums">{value}</dd>
		</div>
	);
}

export function CanvasNodeSummary({
	counted,
	node,
	store,
}: {
	/** Without a feed there are no numbers to show, only health. */
	counted: boolean;
	node: CanvasNode;
	store: CanvasLiveStore;
}) {
	const counters = useNodeCounters(store, node.id);
	if (!(counted && carriesRequests(node))) {
		return node.health ? (
			<dl className="grid grid-cols-3 gap-3">
				<Stat label="Health" value={HEALTH_LABELS[node.health]} />
			</dl>
		) : null;
	}
	return (
		<dl className="grid grid-cols-3 gap-3">
			<Stat label="Requests" value={formatCount(counters.requests)} />
			<Stat label="Blocked" value={formatCount(counters.blocked)} />
			{typeof counters.p50Ms === "number" ? (
				<Stat label="Median" value={`${Math.round(counters.p50Ms)} ms`} />
			) : null}
			{counters.costMicroUsd ? (
				<Stat label="Cost" value={usdFromMicro(counters.costMicroUsd)} />
			) : null}
			{node.health ? (
				<Stat label="Health" value={HEALTH_LABELS[node.health]} />
			) : null}
		</dl>
	);
}

export function CanvasNodePanel({
	children,
	className,
	counted,
	node,
	onClose,
	store,
}: {
	children: ReactNode;
	className?: string;
	counted: boolean;
	node: CanvasNode;
	onClose: () => void;
	store: CanvasLiveStore;
}) {
	const Icon = KIND_ICON[node.kind];
	const headingRef = useRef<HTMLHeadingElement>(null);
	const tl = useLiteralMessages();
	// Move focus into the panel when it opens or switches node, so keyboard
	// users land on what they just opened.
	useEffect(() => {
		headingRef.current?.focus();
	}, []);
	return (
		<section
			aria-label={tl("{label} settings", { label: node.label })}
			className={cn(
				"flex max-h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground",
				className
			)}
			data-canvas-panel={node.id}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.stopPropagation();
					onClose();
				}
			}}
		>
			<header className="flex items-start gap-2 border-border border-b px-3.5 py-3">
				<Icon
					aria-hidden="true"
					className="mt-0.5 size-4 shrink-0 text-muted-foreground"
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h3
						className="truncate font-medium text-sm outline-none"
						ref={headingRef}
						tabIndex={-1}
					>
						{node.label}
					</h3>
					<p className="flex items-center gap-1.5 text-muted-foreground text-xs">
						{node.health ? <HealthDot health={node.health} /> : null}
						{NODE_KIND_LABELS[node.kind]}
						{node.locked ? " · Locked" : null}
						{node.detail ? ` · ${node.detail}` : null}
					</p>
				</div>
				<Button
					aria-label="Close panel"
					className="size-7 shrink-0 text-muted-foreground"
					onClick={onClose}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<X aria-hidden="true" className="size-4" />
				</Button>
			</header>
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3.5 py-3">
				<CanvasNodeSummary counted={counted} node={node} store={store} />
				{children}
			</div>
		</section>
	);
}
