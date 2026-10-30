import type {
	InterfacePort,
	InterfaceSnapshot,
	ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { AnimatePresence, motion } from "motion/react";
import {
	type ComponentType,
	type CSSProperties,
	lazy,
	type ReactNode,
	type RefObject,
	Suspense,
	useEffect,
} from "react";
import { KnowledgeFlat } from "./knowledge-flat.tsx";
import type { useKnowledgeInteractions } from "./knowledge-interface-interactions.ts";
import {
	type KnowledgeGraph,
	type KnowledgeNode,
	plural,
} from "./knowledge-model.ts";
import { cssColor, type KnowledgePalette } from "./knowledge-palette.ts";
import { KnowledgePanel, type KnowledgePanelView } from "./knowledge-panel.tsx";
import {
	KnowledgeEmpty,
	KnowledgeLabels,
	KnowledgeLegend,
	KnowledgeLegendButton,
	KnowledgeNodeList,
	KnowledgeSceneBoundary,
	KnowledgeSkeleton,
	KnowledgeZoom,
	type SkeletonOutline,
} from "./knowledge-parts.tsx";
import type { CameraApi, KnowledgeRendererProps } from "./knowledge-stage.ts";

/** Stands in when the WebGL chunk fails to load: hands over to 2D at once. */
function SceneUnavailable({ onLost }: KnowledgeRendererProps) {
	useEffect(() => {
		onLost?.();
	}, [onLost]);
	return null;
}

const KnowledgeScene = lazy<ComponentType<KnowledgeRendererProps>>(() =>
	import("./knowledge-scene.tsx").catch(() => ({ default: SceneUnavailable }))
);

export interface KnowledgeInterfaceViewProps {
	actions: ReturnType<typeof useKnowledgeInteractions>;
	announcement: string;
	cameraApi: { readonly current: CameraApi | null };
	chromeRef: RefObject<HTMLDivElement | null>;
	cursor: string | null;
	flat: boolean;
	graph: KnowledgeGraph;
	hasGraph: boolean;
	headingRef: RefObject<HTMLHeadingElement | null>;
	hovered: string | null;
	isEmpty: boolean;
	legend: {
		agents: string[];
		kinds: Set<KnowledgeNode["kind"]>;
		statuses: Set<ThreadStatus>;
	};
	loading: boolean;
	localTitle: string;
	needsOutline: boolean;
	now: number;
	onLost: () => void;
	ordered: KnowledgeNode[];
	outline: SkeletonOutline | null;
	palette: KnowledgePalette;
	port: InterfacePort;
	ready: boolean;
	reduced: boolean;
	register: (id: string, element: HTMLElement | null) => void;
	rendererProps: KnowledgeRendererProps;
	rootRef: RefObject<HTMLDivElement | null>;
	sceneLabel: string;
	sceneReady: boolean;
	selected: string | null;
	setCursor: (cursor: string | null) => void;
	setHovered: (hovered: string | null) => void;
	settingsControl: ReactNode;
	snapshot: InterfaceSnapshot;
	stageRef: RefObject<HTMLDivElement | null>;
	stageSectionRef: RefObject<HTMLElement | null>;
	threadView: ReactNode | null;
	view: KnowledgePanelView | null;
	visible: KnowledgeGraph;
}

/** The knowledge graph's markup: the stage, its chrome and the side panel. */
export function KnowledgeInterfaceView({
	actions,
	announcement,
	cameraApi,
	chromeRef,
	cursor,
	flat,
	graph,
	hasGraph,
	headingRef,
	hovered,
	isEmpty,
	legend,
	loading,
	localTitle,
	needsOutline,
	now,
	onLost,
	ordered,
	outline,
	palette,
	port,
	ready,
	reduced,
	register,
	rendererProps,
	rootRef,
	sceneLabel,
	sceneReady,
	selected,
	setCursor,
	setHovered,
	settingsControl,
	snapshot,
	stageRef,
	stageSectionRef,
	threadView,
	view,
	visible,
}: KnowledgeInterfaceViewProps) {
	const {
		back,
		close,
		newThread,
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onRootKeyDown,
		onSceneKeyDown,
		openThread,
		select,
	} = actions;
	return (
		<div
			className="@container/knowledge relative flex size-full min-h-0 overflow-hidden bg-background text-foreground"
			data-mode={palette.mode}
			data-testid="interface-knowledge"
			onKeyDown={onRootKeyDown}
			ref={rootRef}
		>
			<section
				aria-busy={loading}
				aria-label="Knowledge"
				className="@container/stage relative isolate min-h-0 min-w-0 flex-1 overflow-hidden"
				ref={stageSectionRef}
				style={
					{
						"--knowledge-halo": cssColor(palette.background),
						backgroundColor: cssColor(palette.background),
					} as CSSProperties
				}
			>
				<div
					aria-label={sceneLabel}
					aria-roledescription="knowledge graph"
					className="absolute inset-0 opacity-0 outline-none transition-opacity duration-300 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset data-[hover=true]:cursor-pointer data-[ready=true]:opacity-100 data-[cursor=true]:ring-0 motion-reduce:transition-none"
					data-cursor={cursor ? "true" : "false"}
					data-hover={hovered ? "true" : "false"}
					data-ready={sceneReady || outline?.paint ? "true" : "false"}
					onBlur={() => setCursor(null)}
					onKeyDown={onSceneKeyDown}
					onPointerDown={onPointerDown}
					onPointerLeave={() => setHovered(null)}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					ref={stageRef}
					role="application"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the graph is a keyboard-driven canvas (role="application").
					tabIndex={0}
				>
					{ready && !flat ? (
						<KnowledgeSceneBoundary onError={onLost}>
							<Suspense fallback={null}>
								<KnowledgeScene {...rendererProps} />
							</Suspense>
						</KnowledgeSceneBoundary>
					) : null}
					{ready && flat ? <KnowledgeFlat {...rendererProps} /> : null}
					{hasGraph ? (
						<KnowledgeLabels nodes={visible.nodes} register={register} />
					) : null}
				</div>

				<AnimatePresence>
					{loading || needsOutline ? (
						<motion.div
							animate={{ opacity: 1 }}
							className="pointer-events-none absolute inset-0"
							exit={{ opacity: 0, transition: { duration: 0.2 } }}
							initial={false}
							key="skeleton"
						>
							<KnowledgeSkeleton outline={loading ? null : outline} />
						</motion.div>
					) : null}
				</AnimatePresence>

				<div
					className="pointer-events-none absolute inset-0 z-20 flex flex-col justify-between gap-3 p-3 sm:p-4"
					ref={chromeRef}
				>
					<div className="flex min-h-0 items-start justify-between gap-3">
						<header
							className="flex min-w-0 flex-col gap-0.5 pt-1.5"
							data-knowledge-chrome="band"
						>
							<h2 className="truncate font-semibold text-base text-foreground leading-6">
								{localTitle}
							</h2>
							<p className="text-[13px] text-muted-foreground tabular-nums leading-5">
								{loading
									? "Loading workspace"
									: `${plural(visible.nodes.length, "node")} · ${plural(visible.links.length, "link")}`}
							</p>
						</header>
						{settingsControl}
					</div>
					{ready ? (
						<div className="flex items-end justify-between gap-3">
							<div
								className="@min-[620px]/stage:block hidden min-w-0"
								data-knowledge-chrome=""
							>
								<KnowledgeLegend
									agents={legend.agents}
									kinds={legend.kinds}
									palette={palette}
									statuses={legend.statuses}
								/>
							</div>
							<div
								className="@min-[620px]/stage:hidden"
								data-knowledge-chrome=""
							>
								<KnowledgeLegendButton
									agents={legend.agents}
									kinds={legend.kinds}
									palette={palette}
									statuses={legend.statuses}
								/>
							</div>
							<div className="ms-auto" data-knowledge-chrome="">
								<KnowledgeZoom
									onFit={() => cameraApi.current?.reset()}
									onZoom={(factor) => cameraApi.current?.zoom(factor)}
								/>
							</div>
						</div>
					) : null}
				</div>

				<AnimatePresence>
					{isEmpty ? (
						<motion.div
							animate={{ opacity: 1 }}
							className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-6"
							initial={reduced ? false : { opacity: 0 }}
							key="empty"
						>
							<KnowledgeEmpty onStart={() => port.startThread({})} />
						</motion.div>
					) : null}
				</AnimatePresence>
				{ready ? (
					<KnowledgeNodeList
						nodes={ordered}
						onSelect={(id) => select(id)}
						selectedId={selected}
					/>
				) : null}
				<p aria-live="polite" className="sr-only">
					{announcement}
				</p>
			</section>
			{view ? (
				<KnowledgePanel
					graph={graph}
					headingRef={headingRef}
					now={now}
					onBack={back}
					onClose={close}
					onNewThread={newThread}
					onOpenThread={openThread}
					onSelect={(id) => select(id)}
					palette={palette}
					snapshot={snapshot}
					threadView={threadView}
					view={view}
				/>
			) : null}
		</div>
	);
}
