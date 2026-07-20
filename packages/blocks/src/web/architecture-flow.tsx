"use client";

import {
	Background,
	BackgroundVariant,
	type Edge,
	Handle,
	type Node,
	type NodeProps,
	type NodeTypes,
	Position,
	ReactFlow,
	useEdgesState,
	useNodesState,
} from "@xyflow/react";
import {
	Cpu,
	Globe,
	MessageCircle,
	Monitor,
	Puzzle,
	Smartphone,
	TerminalSquare,
} from "lucide-react";
import { type ComponentType, useEffect, useMemo, useState } from "react";
import { ArchitectureStacked } from "./architecture.tsx";

/**
 * The canonical, interactive data-flow diagram: any surface routes through the
 * Ryu Gateway, into Core, and out to any engine. Built on React Flow so nodes are
 * draggable and the whole graph reads as a live system, not a static picture.
 *
 * Nodes and edges live in React Flow state so the graph never mounts as an empty
 * shell when the page hydrates.
 * Colors are theme tokens (--foreground / --card / --muted / --border) so it
 * themes for free in light, dark, and midnight.
 */

type IconType = ComponentType<{ className?: string }>;

const HANDLE_CLASS = "!size-1.5 !min-w-0 !min-h-0 !border-0 !bg-foreground/25";

const SURFACES = [
	{ id: "desktop", label: "Desktop" },
	{ id: "mobile", label: "Mobile" },
	{ id: "cli", label: "CLI" },
	{ id: "extension", label: "Extension" },
	{ id: "bots", label: "Bots" },
	{ id: "web", label: "Web" },
] as const;
type SurfaceId = (typeof SURFACES)[number]["id"];

const SURFACE_ICONS: Record<SurfaceId, IconType> = {
	bots: MessageCircle,
	cli: TerminalSquare,
	desktop: Monitor,
	extension: Puzzle,
	mobile: Smartphone,
	web: Globe,
};

const ENGINES = [
	"OpenAI",
	"Claude Code",
	"Pi",
	"OpenClaw",
	"Hermes",
	"llama.cpp",
] as const;

const GATEWAY_PILLS = [
	"Routing",
	"Firewall",
	"PII / DLP",
	"Budgets",
	"Evals",
	"Audit",
] as const;

const CORE_PILLS = [
	"Sessions",
	"Memory",
	"Tools",
	"Workflows",
	"Sub-agents",
	"Sidecars",
] as const;

function SurfaceNode({ data }: NodeProps) {
	const { label, surfaceId } = data as { label: string; surfaceId: SurfaceId };
	const Icon = SURFACE_ICONS[surfaceId];
	return (
		<div className="flex w-[150px] items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 shadow-sm">
			<Icon className="size-4 shrink-0 text-muted-foreground" />
			<span className="font-medium text-foreground text-sm">{label}</span>
			<Handle
				className={HANDLE_CLASS}
				id="out"
				position={Position.Right}
				type="source"
			/>
		</div>
	);
}

function EngineNode({ data }: NodeProps) {
	const { label } = data as { label: string };
	return (
		<div className="flex w-[150px] items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 shadow-sm">
			<Cpu className="size-4 shrink-0 text-muted-foreground" />
			<span className="font-medium text-foreground text-sm">{label}</span>
			<Handle
				className={HANDLE_CLASS}
				id="in"
				position={Position.Left}
				type="target"
			/>
		</div>
	);
}

function GatewayNode() {
	return (
		<div className="w-[240px] rounded-2xl bg-foreground p-4 text-background shadow-lg">
			<Handle
				className="!size-1.5 !min-w-0 !min-h-0 !border-0 !bg-background/40"
				id="in"
				position={Position.Left}
				type="target"
			/>
			<div className="flex items-start justify-between gap-2">
				<div>
					<p className="font-semibold text-[10px] text-background/60 uppercase tracking-widest">
						Control
					</p>
					<h3 className="font-semibold text-lg tracking-tight">Ryu Gateway</h3>
				</div>
			</div>
			<p className="mt-1 text-background/65 text-xs">
				decides what&apos;s allowed, shared, measured &amp; paid for
			</p>
			<div className="mt-3 grid grid-cols-2 gap-1.5">
				{GATEWAY_PILLS.map((pill) => (
					<span
						className="rounded-md bg-background px-2 py-1.5 text-center font-medium text-[11px] text-foreground"
						key={pill}
					>
						{pill}
					</span>
				))}
			</div>
			<Handle
				className="!size-1.5 !min-w-0 !min-h-0 !border-0 !bg-background/40"
				id="out"
				position={Position.Right}
				type="source"
			/>
		</div>
	);
}

function CoreNode() {
	return (
		<div className="w-[240px] rounded-2xl border border-border bg-card p-4 shadow-md">
			<Handle
				className={HANDLE_CLASS}
				id="in"
				position={Position.Left}
				type="target"
			/>
			<p className="font-semibold text-[10px] text-muted-foreground uppercase tracking-widest">
				Orchestration
			</p>
			<h3 className="font-semibold text-foreground text-lg tracking-tight">
				Ryu Core
			</h3>
			<p className="mt-1 text-muted-foreground text-xs">
				decides what runs, then calls the Gateway
			</p>
			<div className="mt-3 grid grid-cols-2 gap-1.5">
				{CORE_PILLS.map((pill) => (
					<span
						className="rounded-md bg-muted px-2 py-1.5 text-center font-medium text-[11px] text-foreground"
						key={pill}
					>
						{pill}
					</span>
				))}
			</div>
			<Handle
				className={HANDLE_CLASS}
				id="out"
				position={Position.Right}
				type="source"
			/>
		</div>
	);
}

const FLOW_NODE_TYPES = {
	surface: SurfaceNode,
	engine: EngineNode,
	gateway: GatewayNode,
	core: CoreNode,
} satisfies NodeTypes;

const SURFACE_STEP = 62;
const GATEWAY_Y = 70;

const initialNodes: Node[] = [
	...SURFACES.map(
		(surface, i): Node => ({
			id: surface.id,
			type: "surface",
			position: { x: 0, y: i * SURFACE_STEP },
			data: { label: surface.label, surfaceId: surface.id },
		})
	),
	{
		id: "gateway",
		type: "gateway",
		position: { x: 320, y: GATEWAY_Y },
		data: {},
	},
	{ id: "core", type: "core", position: { x: 660, y: GATEWAY_Y }, data: {} },
	...ENGINES.map(
		(label, i): Node => ({
			id: `engine-${i}`,
			type: "engine",
			position: { x: 1000, y: i * SURFACE_STEP },
			data: { label },
		})
	),
];

const EDGE_STYLE = {
	stroke: "var(--muted-foreground)",
	strokeWidth: 1.5,
	opacity: 0.5,
};
const SPINE_STYLE = {
	stroke: "var(--foreground)",
	strokeWidth: 2,
	opacity: 0.65,
};

const initialEdges: Edge[] = [
	...SURFACES.map(
		(surface): Edge => ({
			id: `e-${surface.id}-gw`,
			source: surface.id,
			sourceHandle: "out",
			target: "gateway",
			targetHandle: "in",
			type: "smoothstep",
			animated: true,
			style: EDGE_STYLE,
		})
	),
	{
		id: "e-gw-core",
		source: "gateway",
		sourceHandle: "out",
		target: "core",
		targetHandle: "in",
		type: "smoothstep",
		animated: true,
		style: SPINE_STYLE,
	},
	...ENGINES.map(
		(_label, i): Edge => ({
			id: `e-core-engine-${i}`,
			source: "core",
			sourceHandle: "out",
			target: `engine-${i}`,
			targetHandle: "in",
			type: "smoothstep",
			animated: true,
			style: EDGE_STYLE,
		})
	),
];

export default function ArchitectureFlow() {
	// React Flow measures the DOM, so only render once mounted on the client to
	// avoid a hydration mismatch and a zero-height first paint.
	const [mounted, setMounted] = useState(false);
	const [nodes, _setNodes, onNodesChange] = useNodesState(initialNodes);
	const [edges, _setEdges, onEdgesChange] = useEdgesState(initialEdges);
	const nodeTypes = useMemo(() => FLOW_NODE_TYPES, []);

	useEffect(() => {
		setMounted(true);
	}, []);

	return (
		<>
			{/* Desktop / tablet: the live, draggable graph */}
			<div className="hidden md:block">
				<div className="h-[560px] w-full overflow-hidden rounded-2xl border border-border/60 bg-muted/20">
					{mounted ? (
						<ReactFlow
							className="!bg-transparent"
							edges={edges}
							fitView
							fitViewOptions={{ padding: 0.14 }}
							maxZoom={1.4}
							minZoom={0.4}
							nodes={nodes}
							nodesConnectable={false}
							nodeTypes={nodeTypes}
							onEdgesChange={onEdgesChange}
							onNodesChange={onNodesChange}
							panOnScroll={false}
							preventScrolling={false}
							proOptions={{ hideAttribution: true }}
							zoomOnDoubleClick={false}
							zoomOnScroll={false}
						>
							<Background
								color="var(--border)"
								gap={22}
								size={1}
								variant={BackgroundVariant.Dots}
							/>
						</ReactFlow>
					) : null}
				</div>
			</div>

			{/* Mobile: the same layers, stacked */}
			<div className="md:hidden">
				<ArchitectureStacked />
			</div>
		</>
	);
}
