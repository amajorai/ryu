import { cn } from "@ryu/ui/lib/utils";
import { Maximize, Minus, Plus } from "lucide-react";
import {
	createContext,
	type RefObject,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { GAME_PLATE, GameIconButton } from "./game-hud.tsx";
import { CRAMPED_STAGE } from "./game3d-plates.ts";
import {
	probeWebGL,
	type RenderQuality,
	type WebGLProbe,
} from "./game3d-toon.ts";
import { isInterfaceCovered } from "./interface-keys.ts";

type ViewListener = (command: "in" | "out" | "reset") => void;

type FocusListener = (targetId: string) => void;

/** The stage's zoom, driven by the HUD's zoom plate and the keyboard. */
export interface IsoView {
	/**
	 * Smoothly pans (and zooms in a little) so the plate marked
	 * `data-iso-focus={targetId}` sits in the middle of the uncovered
	 * stage: call it when a sheet opens on that object.
	 */
	focusOnTarget: (targetId: string) => void;
	listen: (listener: ViewListener) => () => void;
	listenFocus: (listener: FocusListener) => () => void;
	send: (command: "in" | "out" | "reset") => void;
}

/** A zoom channel shared by an `IsoStage` and its `IsoZoomControls`. */
export function useIsoView(): IsoView {
	return useMemo(() => {
		const listeners = new Set<ViewListener>();
		const focusListeners = new Set<FocusListener>();
		return {
			focusOnTarget: (targetId) => {
				for (const listener of focusListeners) {
					listener(targetId);
				}
			},
			listenFocus: (listener) => {
				focusListeners.add(listener);
				return () => focusListeners.delete(listener);
			},
			listen: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			send: (command) => {
				for (const listener of listeners) {
					listener(command);
				}
			},
		};
	}, []);
}

/**
 * Focuses the stage on `targetId` whenever it changes to a new object (a
 * sheet opened on it). Waits two frames so the stage has refitted beside
 * the sheet before it measures the plate.
 */
export function useFocusOnOpen(
	view: IsoView | undefined,
	targetId: string | null | undefined
): void {
	useEffect(() => {
		if (!(view && targetId)) {
			return;
		}
		let frame = requestAnimationFrame(() => {
			frame = requestAnimationFrame(() => view.focusOnTarget(targetId));
		});
		return () => cancelAnimationFrame(frame);
	}, [targetId, view]);
}

/** The HUD's zoom plate: zoom in, zoom out, and fit the whole diorama. */
export function IsoZoomControls({ view }: { view: IsoView }) {
	return (
		<div
			aria-label="Zoom"
			className={cn(
				GAME_PLATE,
				"pointer-events-auto flex flex-col items-center gap-1.5 p-1.5"
			)}
			role="group"
		>
			<GameIconButton label="Zoom in" onClick={() => view.send("in")}>
				<Plus aria-hidden="true" className="size-5" />
			</GameIconButton>
			<GameIconButton label="Zoom out" onClick={() => view.send("out")}>
				<Minus aria-hidden="true" className="size-5" />
			</GameIconButton>
			<GameIconButton label="Fit to view" onClick={() => view.send("reset")}>
				<Maximize aria-hidden="true" className="size-4" />
			</GameIconButton>
		</div>
	);
}

/** The stage's render quality, for kit pieces that trim on a slow renderer. */
export const StageQuality = createContext<RenderQuality>("high");

/** The render quality of the stage this is drawn in ("high" outside one). */
export function useStageQuality(): RenderQuality {
	return useContext(StageQuality);
}

/**
 * Whether the stage is cramped: shorter than CRAMPED_STAGE, as when a
 * thread view squeezes it. IsoStage measures itself and provides it, so act
 * pieces drop their lowest-priority words (board "Next:" lines) on their own.
 */
export const StageCramped = createContext(false);

/** Whether the stage this is drawn in is cramped (false outside one). */
export function useStageCramped(): boolean {
	return useContext(StageCramped);
}

/**
 * `null` until checked on the client, then whether WebGL is available and
 * whether it runs on a software rasterizer (which gets the light budget).
 */
export function useWebGLProbe(): WebGLProbe | null {
	const [probe, setProbe] = useState<WebGLProbe | null>(null);
	useEffect(() => {
		setProbe(probeWebGL());
	}, []);
	return probe;
}

/**
 * Whether the stage at `ref` sits in a dark theme (the `.dark` class on an
 * ancestor): night in the diorama. Re-read when the class changes.
 */
export function useGameNight(ref: RefObject<HTMLElement | null>): boolean {
	const [night, setNight] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const update = () => setNight(element.closest(".dark") !== null);
		update();
		if (typeof MutationObserver === "undefined") {
			return;
		}
		const observer = new MutationObserver(update);
		const options = { attributeFilter: ["class"], attributes: true };
		observer.observe(element.ownerDocument.documentElement, options);
		if (element.ownerDocument.body) {
			observer.observe(element.ownerDocument.body, options);
		}
		return () => observer.disconnect();
	}, [ref]);
	return night;
}

/**
 * Whether the stage is on screen, the tab visible and the interface not under
 * a host page (else no frames). A page the host opens over the interface
 * (Settings, the Marketplace) neither scrolls the stage out of view nor hides
 * the tab, so the cover is read from the interface root's `inert` ancestor.
 */
export function useStageVisible(ref: RefObject<HTMLElement | null>): boolean {
	const [inView, setInView] = useState(true);
	const [pageVisible, setPageVisible] = useState(true);
	const [covered, setCovered] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof MutationObserver === "undefined") {
			return;
		}
		// The renderer's own panels make parts of its tree inert; only an inert
		// ancestor of the whole interface is the host's cover.
		const shell = element.closest("[data-game-shell]") ?? element;
		const update = () => setCovered(isInterfaceCovered(shell));
		update();
		const observer = new MutationObserver(update);
		observer.observe(document.body, {
			attributeFilter: ["inert"],
			attributes: true,
			subtree: true,
		});
		return () => observer.disconnect();
	}, [ref]);
	useEffect(() => {
		const update = () => setPageVisible(document.visibilityState !== "hidden");
		update();
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof IntersectionObserver === "undefined") {
			return;
		}
		const observer = new IntersectionObserver(([entry]) => {
			if (entry) {
				setInView(entry.isIntersecting);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return inView && pageVisible && !covered;
}

/** Whether the element at `ref` is shorter than CRAMPED_STAGE (measured). */
export function useCrampedStage(ref: RefObject<HTMLElement | null>): boolean {
	const [cramped, setCramped] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(([entry]) => {
			const height = entry?.contentRect.height ?? 0;
			setCramped(height > 0 && height < CRAMPED_STAGE);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return cramped;
}
