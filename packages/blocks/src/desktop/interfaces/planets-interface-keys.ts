import { type KeyboardEvent, type RefObject, useEffect, useRef } from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import { escapeIsFree } from "./planets-interface-settings.ts";
import { cyclePlanet } from "./planets-model.ts";
import { STAR_ID } from "./planets-overlay.tsx";
import type { CameraApi } from "./planets-scene.tsx";

/**
 * The Planets' keys: Escape steps back (from the document and the root),
 * and the scene region's own keys visit planets and zoom.
 */
export function usePlanetsKeys({
	cameraApi,
	close,
	focusHeading,
	focusId,
	planets,
	rootRef,
	select,
	stepBack,
}: {
	cameraApi: RefObject<CameraApi | null>;
	close: () => void;
	focusHeading: RefObject<boolean>;
	focusId: string | null;
	planets: Parameters<typeof cyclePlanet>[0];
	rootRef: RefObject<HTMLDivElement | null>;
	select: (bodyId: string) => void;
	stepBack: () => boolean;
}) {
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
	}, []);

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

	/** The scene region's own keys: arrows visit planets, +/- zoom, 0 resets. */
	const onSceneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.target !== event.currentTarget) {
			return;
		}
		if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
			event.preventDefault();
			const next = cyclePlanet(
				planets,
				focusId,
				event.key === "ArrowRight" ? 1 : -1
			);
			if (next) {
				select(next);
				// Keep keyboard control in the scene while visiting.
				focusHeading.current = false;
			}
		} else if (event.key === "+" || event.key === "=") {
			event.preventDefault();
			cameraApi.current?.zoom(0.72);
		} else if (event.key === "-" || event.key === "_") {
			event.preventDefault();
			cameraApi.current?.zoom(1.38);
		} else if (event.key === "0") {
			event.preventDefault();
			close();
		} else if (event.key === "Enter" && focusId === null) {
			event.preventDefault();
			select(planets[0]?.id ?? STAR_ID);
		}
	};
	return { onRootKeyDown, onSceneKeyDown };
}
