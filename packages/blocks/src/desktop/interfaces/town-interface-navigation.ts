import {
	type KeyboardEvent,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import { escapeIsFree } from "./town-interface-layout.tsx";
import type { TownCamera } from "./town-scene.tsx";

/**
 * Escape steps back one level, on the page (when nothing covers the
 * interface) and inside the town (unless a text field holds it).
 */
export function useTownEscape(
	rootRef: RefObject<HTMLDivElement | null>,
	stepBack: () => boolean
) {
	const stepBackRef = useRef(stepBack);
	stepBackRef.current = stepBack;

	useEffect(() => {
		const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				event.target !== document.body
			) {
				return;
			}
			if (stepBackRef.current()) {
				event.preventDefault();
			}
		};
		document.addEventListener("keydown", onDocumentKeyDown);
		return () => document.removeEventListener("keydown", onDocumentKeyDown);
	}, [rootRef]);

	const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key !== "Escape" ||
			event.defaultPrevented ||
			!escapeIsFree(event.target)
		) {
			return;
		}
		if (stepBackRef.current()) {
			event.preventDefault();
		}
	};
	return onRootKeyDown;
}

/**
 * Keep the camera on whoever the panel is about, including a thread the
 * host opened before the scene existed. Returns the scene's camera callback.
 */
export function useTownCameraFocus(
	cameraRef: RefObject<TownCamera | null>,
	focusX: number | undefined,
	focusZ: number | undefined
) {
	const pendingFocus = useRef<{ x: number; z: number } | null>(null);
	useEffect(() => {
		if (focusX === undefined || focusZ === undefined) {
			return;
		}
		const target = { x: focusX, z: focusZ };
		if (cameraRef.current) {
			cameraRef.current.focus(target);
		} else {
			pendingFocus.current = target;
		}
	}, [cameraRef, focusX, focusZ]);
	return useCallback(
		(camera: TownCamera) => {
			cameraRef.current = camera;
			if (pendingFocus.current) {
				camera.focus(pendingFocus.current);
				pendingFocus.current = null;
			}
		},
		[cameraRef]
	);
}
