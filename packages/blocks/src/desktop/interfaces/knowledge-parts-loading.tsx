import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { SquarePen } from "lucide-react";

/** The Knowledge map's loading skeleton, outline preview and empty state. */

/** Loose node positions and radii (100 x 60 box) for the loading state. */
const LOADING_NODES: readonly [number, number, number][] = [
	[50, 30, 1.6],
	[36, 22, 1.2],
	[63, 19, 1.2],
	[66, 37, 1.2],
	[40, 40, 1],
	[27, 31, 0.6],
	[47, 14, 0.6],
	[76, 27, 0.6],
	[56, 47, 0.6],
	[30, 47, 0.6],
];
const LOADING_LINKS: readonly [number, number][] = [
	[0, 1],
	[0, 2],
	[0, 3],
	[0, 4],
	[1, 5],
	[1, 6],
	[2, 6],
	[2, 7],
	[3, 7],
	[3, 8],
	[4, 9],
];

/** The graph as it will first draw: screen points, links and stage size. */
export interface SkeletonOutline {
	height: number;
	links: readonly [number, number][];
	/** Per node: x, y and disc radius in stage pixels. */
	nodes: readonly [number, number, number][];
	/**
	 * The graph's own colours, when known: the outline is then a still
	 * preview of the first frame rather than a pulsing placeholder.
	 */
	paint?: OutlinePaint;
	width: number;
}

export interface OutlinePaint {
	/** Per node: drawn with the agent's inner cut. */
	agents: readonly boolean[];
	/** The canvas colour (the agent cut). */
	background: string;
	link: string;
	/** Per node CSS colour. */
	nodes: readonly string[];
}

/** The agent cut, as the renderers draw it (fraction of the disc). */
const PREVIEW_AGENT_CUT = 0.62;

function OutlinePreview({
	links,
	nodes,
	paint,
}: {
	links: readonly [number, number][];
	nodes: readonly [number, number, number][];
	paint: OutlinePaint;
}) {
	return (
		<>
			<g stroke={paint.link} strokeWidth={1}>
				{links.map(([from, to]) => {
					const a = nodes[from];
					const b = nodes[to];
					return a && b ? (
						<line
							key={`${from}-${to}`}
							x1={a[0]}
							x2={b[0]}
							y1={a[1]}
							y2={b[1]}
						/>
					) : null;
				})}
			</g>
			{nodes.map(([x, y, radius], index) => {
				const cut = Math.max(1.25, radius * 0.1);
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: preview nodes are positional and never reorder.
					<g key={index}>
						<circle cx={x} cy={y} fill={paint.nodes[index]} r={radius} />
						{paint.agents[index] && radius >= 4 ? (
							<circle
								cx={x}
								cy={y}
								fill="none"
								r={radius * PREVIEW_AGENT_CUT + cut / 2}
								stroke={paint.background}
								strokeWidth={cut}
							/>
						) : null}
					</g>
				);
			})}
		</>
	);
}

function OutlineShape({
	links,
	nodes,
	strokeWidth,
}: {
	links: readonly [number, number][];
	nodes: readonly [number, number, number][];
	strokeWidth: number;
}) {
	return (
		<>
			<g className="stroke-foreground/15" strokeWidth={strokeWidth}>
				{links.map(([from, to]) => {
					const a = nodes[from];
					const b = nodes[to];
					return a && b ? (
						<line
							key={`${from}-${to}`}
							x1={a[0]}
							x2={b[0]}
							y1={a[1]}
							y2={b[1]}
						/>
					) : null;
				})}
			</g>
			<g className="fill-foreground/15">
				{nodes.map(([x, y, radius], index) => (
					<circle
						cx={x}
						cy={y}
						// biome-ignore lint/suspicious/noArrayIndexKey: outline nodes are positional and never reorder.
						key={index}
						r={radius}
					/>
				))}
			</g>
		</>
	);
}

/**
 * The graph's outline while it loads. Once the layout exists (the WebGL view
 * is still starting), `outline` is that layout projected through the very
 * pose the 3D view opens with and painted in the graph's colours, so the
 * first frame shows at once and the 3D view cross-fades in over it; before
 * that (workspace loading) it is a loose, pulsing generic graph.
 */
export function KnowledgeSkeleton({
	outline,
}: {
	outline: SkeletonOutline | null;
}) {
	if (outline?.paint) {
		return (
			<svg
				aria-hidden="true"
				className="absolute inset-0 size-full"
				data-knowledge-preview=""
				fill="none"
				viewBox={`0 0 ${Math.max(1, outline.width)} ${Math.max(1, outline.height)}`}
			>
				<OutlinePreview
					links={outline.links}
					nodes={outline.nodes}
					paint={outline.paint}
				/>
			</svg>
		);
	}
	if (outline) {
		return (
			<svg
				aria-hidden="true"
				className="absolute inset-0 size-full animate-skeleton motion-reduce:animate-none"
				fill="none"
				viewBox={`0 0 ${Math.max(1, outline.width)} ${Math.max(1, outline.height)}`}
			>
				<OutlineShape
					links={outline.links}
					nodes={outline.nodes}
					strokeWidth={1}
				/>
			</svg>
		);
	}
	return (
		<div
			aria-hidden="true"
			className="absolute inset-0 flex items-center justify-center p-16"
		>
			<svg
				className="aspect-[5/3] max-h-full w-full max-w-3xl animate-skeleton motion-reduce:animate-none"
				fill="none"
				preserveAspectRatio="xMidYMid meet"
				viewBox="20 8 64 44"
			>
				<OutlineShape
					links={LOADING_LINKS}
					nodes={LOADING_NODES}
					strokeWidth={0.15}
				/>
			</svg>
		</div>
	);
}

export function KnowledgeEmpty({ onStart }: { onStart: () => void }) {
	return (
		<Empty className="pointer-events-auto max-w-md flex-none p-6">
			<svg
				aria-hidden="true"
				className="mb-1 h-12 w-24 text-muted-foreground"
				fill="none"
				viewBox="0 0 96 48"
			>
				<g opacity="0.45" stroke="currentColor" strokeWidth="1">
					<line x1="20" x2="48" y1="30" y2="16" />
					<line x1="48" x2="76" y1="16" y2="32" />
					<line x1="48" x2="50" y1="16" y2="40" />
				</g>
				<g fill="currentColor">
					<circle cx="48" cy="16" opacity="0.8" r="6" />
					<circle cx="20" cy="30" opacity="0.5" r="4" />
					<circle cx="76" cy="32" opacity="0.5" r="4" />
					<circle cx="50" cy="40" opacity="0.35" r="3" />
				</g>
			</svg>
			<EmptyHeader>
				<EmptyTitle className="text-base">Nothing to graph yet</EmptyTitle>
				<EmptyDescription>
					Agents, projects, teams and conversations appear here as linked nodes,
					with shared topics drawn from conversation titles.
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button onClick={onStart} size="sm" type="button">
					<SquarePen aria-hidden="true" data-icon="inline-start" />
					New conversation
				</Button>
			</EmptyContent>
		</Empty>
	);
}
