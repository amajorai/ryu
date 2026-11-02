import { useFrame } from "@react-three/fiber";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import type { InterfacePort, World3dParams } from "@ryuhq/protocol/interfaces";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { threadSpeaker } from "./world-3d-model.ts";

/**
 * Frames before the world counts as shown: the first frame compiles the
 * shaders and draws in the same tick, before React hides the cover.
 */
const READY_FRAMES = 1;

/** Calls `onReady` once the scene has drawn its first frames. */
export function FirstFrames({ onReady }: { onReady: () => void }) {
	const frames = useRef(0);
	useFrame(() => {
		frames.current += 1;
		if (frames.current === READY_FRAMES) {
			onReady();
		}
	});
	return null;
}

/**
 * Covers the stage until the scene has drawn (compiling the cel shaders
 * takes a moment, longest on software renderers), so the world never
 * flashes an empty or white frame. The cover is the theme's sky, with the
 * HUD's places held by placeholders, so the scene lands in place.
 */
export function LoadingWorld({
	minimapSize,
	sky,
}: {
	minimapSize: number;
	sky: string;
}) {
	return (
		<div
			className="pointer-events-none absolute inset-0 z-[300] font-sans"
			role="status"
			style={{ background: sky }}
		>
			<span className="sr-only">Loading world</span>
			<div className="absolute top-3 left-3 flex flex-col gap-3">
				<Skeleton
					// Where the minimap's ring lands on the 12px gutter.
					className="@max-[480px]:hidden"
					radius="pill"
					style={{ height: minimapSize, width: minimapSize }}
				/>
				<Skeleton className="h-14 w-64" radius="row" />
			</div>
			<Skeleton
				className="absolute right-3 bottom-3 @max-[480px]:hidden h-8 w-56"
				radius="row"
			/>
		</div>
	);
}

/**
 * The port the shared world controller drives: talking to an agent closes
 * the open thread first, which is only news to the host when one is open.
 */
export function useWorldPort(
	port: InterfacePort,
	activeThreadId: string | null
): InterfacePort {
	const open = useRef(activeThreadId !== null);
	open.current = activeThreadId !== null;
	return useMemo(
		() => ({
			...port,
			closeThread: () => {
				if (open.current) {
					port.closeThread();
				}
			},
		}),
		[port]
	);
}

/**
 * When a thread is opened from outside the world (or was open as it
 * mounted), walk the player up to that thread's agent so the framing and the
 * open panel agree. A thread opened from a conversation keeps its speaker:
 * when the agent the player is talking to is in the thread, nobody moves.
 * Runs once per newly opened thread.
 */
export function useMeetActiveThreadAgent(
	snapshot: InterfaceRendererProps<World3dParams>["snapshot"],
	activeThreadId: string | null,
	world: { meet: (agentId: string) => void; talkingTo: string | null }
): void {
	const agentIds = activeThreadId
		? (snapshot.threads.find((thread) => thread.id === activeThreadId)
				?.agentIds ?? null)
		: null;
	const met = useRef<string | null>(null);
	const { meet, talkingTo } = world;
	useEffect(() => {
		const agentId = agentIds ? threadSpeaker(agentIds, talkingTo) : null;
		if (!(activeThreadId && agentId)) {
			met.current = null;
			return;
		}
		// Keyed by thread: walking away clears the speaker a beat before the
		// host closes the thread, which must not send the player elsewhere.
		if (met.current === activeThreadId) {
			return;
		}
		met.current = activeThreadId;
		if (talkingTo !== agentId) {
			meet(agentId);
		}
	}, [activeThreadId, agentIds, meet, talkingTo]);
}

/** Width of the world's stage, kept in sync on resize. */
export function useStageWidth() {
	const [stage, setStage] = useState<HTMLDivElement | null>(null);
	const [stageWidth, setStageWidth] = useState(1024);
	const stageRef = useCallback((node: HTMLDivElement | null) => {
		setStage(node);
		if (node) {
			setStageWidth(node.getBoundingClientRect().width);
		}
	}, []);
	useEffect(() => {
		if (!stage || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(([entry]) => {
			if (entry) {
				setStageWidth(entry.contentRect.width);
			}
		});
		observer.observe(stage);
		return () => observer.disconnect();
	}, [stage]);
	return { stageRef, stageWidth };
}
