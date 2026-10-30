import type { useCanvasActions } from "./canvas-interface-actions.ts";
import type { useCanvasFit } from "./canvas-interface-fit.ts";
import type { useCanvasPointer } from "./canvas-interface-pointer.ts";
import type {
	useCanvasBase,
	useCanvasBoard,
	useCanvasCamera,
	useCanvasSelection,
} from "./canvas-interface-state.ts";

/** What each canvas hook can read: everything the hooks before it produced. */
export type CanvasBaseScope = ReturnType<typeof useCanvasBase>;
export type CanvasBoardScope = CanvasBaseScope &
	ReturnType<typeof useCanvasBoard>;
export type CanvasCameraScope = CanvasBoardScope &
	ReturnType<typeof useCanvasCamera>;
export type CanvasStateScope = CanvasCameraScope &
	ReturnType<typeof useCanvasSelection>;
export type CanvasFitScope = CanvasStateScope & ReturnType<typeof useCanvasFit>;
export type CanvasActionScope = CanvasFitScope &
	ReturnType<typeof useCanvasActions>;
export type CanvasPointerScope = CanvasActionScope &
	ReturnType<typeof useCanvasPointer>;
