"use client";

// The canvas as a table (spec 07.6): every node, every link's request count
// and every editor entry point, for keyboard and screen-reader users, and the
// default on narrow screens.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { useSyncExternalStore } from "react";
import type { CanvasLiveStore } from "./live-store.ts";
import {
	type CanvasNode,
	type CanvasTopology,
	carriesRequests,
	formatCount,
	HEALTH_LABELS,
	NODE_KIND_LABELS,
} from "./model.ts";
import { useNodeCounters } from "./nodes.tsx";

const CELL = "px-3 py-2 text-left align-middle";
const HEAD = cn(CELL, "font-medium text-muted-foreground text-xs");

const NOT_COUNTED = "Not counted";

function NodeRow({
	counted: feedCounted,
	node,
	onOpen,
	selected,
	store,
}: {
	counted: boolean;
	node: CanvasNode;
	onOpen: (id: string) => void;
	selected: boolean;
	store: CanvasLiveStore;
}) {
	const counters = useNodeCounters(store, node.id);
	const counted = feedCounted && carriesRequests(node);
	const tl = useLiteralMessages();
	return (
		<tr
			className={cn("border-border border-t", selected && "bg-muted/60")}
			data-canvas-row={node.id}
		>
			<th className={cn(CELL, "font-medium")} scope="row">
				<span className="flex flex-col">
					<span>{node.label}</span>
					{node.detail ? (
						<span className="text-muted-foreground text-xs">{node.detail}</span>
					) : null}
				</span>
			</th>
			<td className={cn(CELL, "text-muted-foreground")}>
				{NODE_KIND_LABELS[node.kind]}
				{node.locked ? ", locked" : ""}
			</td>
			<td
				className={cn(
					CELL,
					"tabular-nums",
					!counted && "text-muted-foreground"
				)}
			>
				{counted ? formatCount(counters.requests) : NOT_COUNTED}
			</td>
			<td
				className={cn(
					CELL,
					"tabular-nums",
					!counted && "text-muted-foreground"
				)}
			>
				{counted ? formatCount(counters.blocked) : NOT_COUNTED}
			</td>
			<td className={cn(CELL, "text-muted-foreground")}>
				{node.health ? HEALTH_LABELS[node.health] : "Unknown"}
			</td>
			<td className={cn(CELL, "text-right")}>
				<Button
					aria-expanded={selected}
					aria-label={tl("Open {label}", { label: node.label })}
					onClick={() => onOpen(node.id)}
					size="xs"
					type="button"
					variant="secondary"
				>
					Open
				</Button>
			</td>
		</tr>
	);
}

function LinkRows({
	labels,
	store,
	topology,
}: {
	labels: Map<string, string>;
	store: CanvasLiveStore;
	topology: CanvasTopology;
}) {
	// Link counts change with every tick; read them on the store's batched
	// notification instead of per event.
	useSyncExternalStore(store.subscribe, store.totals, store.totals);
	return (
		<>
			{topology.edges
				.filter((edge) => edge.kind === "traffic")
				.map((edge) => (
					<tr className="border-border border-t" key={edge.id}>
						<th className={cn(CELL, "font-normal")} scope="row">
							{labels.get(edge.from) ?? edge.from}
						</th>
						<td className={CELL}>{labels.get(edge.to) ?? edge.to}</td>
						<td className={cn(CELL, "tabular-nums")}>
							{formatCount(store.edgeCount(edge.from, edge.to))}
						</td>
					</tr>
				))}
		</>
	);
}

export function CanvasTableView({
	counted,
	onOpen,
	order,
	selectedId,
	store,
	topology,
}: {
	/** Whether the feed has numbers; without one, counts read "Not counted". */
	counted: boolean;
	onOpen: (id: string) => void;
	/** Node ids in reading order (the layout's columns, left to right). */
	order: readonly string[];
	selectedId: string | null;
	store: CanvasLiveStore;
	topology: CanvasTopology;
}) {
	const byId = new Map(topology.nodes.map((node) => [node.id, node]));
	const labels = new Map(topology.nodes.map((node) => [node.id, node.label]));
	return (
		<div className="flex flex-col gap-4">
			<div className="overflow-x-auto rounded-lg border border-border">
				<table className="w-full min-w-[560px] border-collapse text-sm">
					<caption className="sr-only">
						Gateway nodes with their request and block counts
					</caption>
					<thead>
						<tr>
							<th className={HEAD} scope="col">
								Node
							</th>
							<th className={HEAD} scope="col">
								Kind
							</th>
							<th className={HEAD} scope="col">
								Requests
							</th>
							<th className={HEAD} scope="col">
								Blocked
							</th>
							<th className={HEAD} scope="col">
								Health
							</th>
							<th className={cn(HEAD, "text-right")} scope="col">
								<span className="sr-only">Settings</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{order.map((id) => {
							const node = byId.get(id);
							return node ? (
								<NodeRow
									counted={counted}
									key={id}
									node={node}
									onOpen={onOpen}
									selected={selectedId === id}
									store={store}
								/>
							) : null;
						})}
					</tbody>
				</table>
			</div>
			{counted ? (
				<div className="overflow-x-auto rounded-lg border border-border">
					<table className="w-full min-w-[420px] border-collapse text-sm">
						<caption className="sr-only">Requests along each link</caption>
						<thead>
							<tr>
								<th className={HEAD} scope="col">
									From
								</th>
								<th className={HEAD} scope="col">
									To
								</th>
								<th className={HEAD} scope="col">
									Requests
								</th>
							</tr>
						</thead>
						<tbody>
							<LinkRows labels={labels} store={store} topology={topology} />
						</tbody>
					</table>
				</div>
			) : null}
		</div>
	);
}
