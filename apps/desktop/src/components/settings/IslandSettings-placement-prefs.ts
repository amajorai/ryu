import { useCallback, useEffect, useRef, useState } from "react";
import {
	clampIslandEdgeOffset,
	DEFAULT_ISLAND_AUTO_JUMP,
	DEFAULT_ISLAND_EDGE_OFFSET,
	DEFAULT_ISLAND_HIDE_ON_FULLSCREEN,
	DEFAULT_ISLAND_SCREEN_PRIVACY,
	getIslandAutoJump,
	getIslandBackground,
	getIslandEdgeOffset,
	getIslandHideOnFullscreen,
	getIslandNotchMode,
	getIslandScreenPrivacy,
	type IslandBackground,
	setIslandAutoJump,
	setIslandBackground,
	setIslandEdgeOffset,
	setIslandHideOnFullscreen,
	setIslandNotchMode,
	setIslandScreenPrivacy,
} from "@/src/lib/api/preferences.ts";
import {
	EDGE_OFFSET_WRITE_DEBOUNCE_MS,
	type IslandTargetGetter,
	type PersistIslandPreferenceChange,
} from "./IslandSettings-constants.ts";

/**
 * Island placement and visibility preferences (notch mode, background, edge
 * offset, auto-jump, hide-on-fullscreen, screen privacy), each loaded from Core
 * on mount and written back optimistically.
 */
export function useIslandPlacementPrefs(
	getTarget: IslandTargetGetter,
	persistPreferenceChange: PersistIslandPreferenceChange
) {
	const [notchMode, setNotchMode] = useState(false);
	useEffect(() => {
		let cancelled = false;
		const target = getTarget();
		void getIslandNotchMode(target).then((value) => {
			if (!cancelled) {
				setNotchMode(value);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const handleNotchMode = (enabled: boolean) => {
		const previous = notchMode;
		setNotchMode(enabled);
		const target = getTarget();
		persistPreferenceChange(
			"island-notch-mode",
			setIslandNotchMode(target, enabled),
			() => setNotchMode(previous)
		);
	};
	// Background. Stored in Core (cross-process), so we load it async on mount and
	// write it back on change; the island picks up the change live via SSE.
	const [islandBg, setIslandBg] = useState<IslandBackground>("acrylic");
	useEffect(() => {
		let cancelled = false;
		const target = getTarget();
		getIslandBackground(target).then((bg) => {
			if (!cancelled) {
				setIslandBg(bg);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const handleIslandBg = (value: string | null) => {
		if (value !== "translucent" && value !== "acrylic" && value !== "mica") {
			return;
		}
		const previous = islandBg;
		setIslandBg(value);
		const target = getTarget();
		persistPreferenceChange(
			"island-appearance",
			setIslandBackground(target, value),
			() => setIslandBg(previous)
		);
	};

	// Edge offset (gap from a docked screen edge). The slider fires continuously
	// while dragging, so the local value updates live but the Core write is
	// debounced to avoid spamming PUTs (and the island re-docking on every tick).
	const [islandEdgeOffset, setIslandEdgeOffsetState] = useState<number>(
		DEFAULT_ISLAND_EDGE_OFFSET
	);
	const persistedEdgeOffset = useRef(DEFAULT_ISLAND_EDGE_OFFSET);
	useEffect(() => {
		let cancelled = false;
		const target = getTarget();
		getIslandEdgeOffset(target).then((offset) => {
			if (!cancelled) {
				persistedEdgeOffset.current = offset;
				setIslandEdgeOffsetState(offset);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const edgeOffsetWriteTimer = useRef<ReturnType<typeof setTimeout> | null>(
		null
	);
	const writeIslandEdgeOffset = useCallback(
		(offset: number) => {
			if (edgeOffsetWriteTimer.current) {
				clearTimeout(edgeOffsetWriteTimer.current);
			}
			edgeOffsetWriteTimer.current = setTimeout(() => {
				const target = getTarget();
				persistPreferenceChange(
					"island-edge-offset",
					setIslandEdgeOffset(target, offset),
					() => setIslandEdgeOffsetState(persistedEdgeOffset.current),
					() => {
						persistedEdgeOffset.current = offset;
					}
				);
			}, EDGE_OFFSET_WRITE_DEBOUNCE_MS);
		},
		[persistPreferenceChange]
	);
	const handleIslandEdgeOffset = (vals: number | readonly number[]) => {
		// SAFETY: This callback's complete numeric port is number | readonly number[]. Native Array.isArray distinguishes those two runtime alternatives, but its mutable-array predicate does not eliminate the readonly array from the declared false branch. Both assertions retain the original numeric values; the array branch only reads index zero and never mutates it.
		const value = Array.isArray(vals)
			? ((vals as readonly number[])[0] ?? DEFAULT_ISLAND_EDGE_OFFSET)
			: (vals as number);
		const clamped = clampIslandEdgeOffset(value);
		setIslandEdgeOffsetState(clamped);
		writeIslandEdgeOffset(clamped);
	};

	// Auto-jump to the active desktop/monitor. Stored in Core (cross-process); the
	// island reads it on startup and starts/stops its follow-the-cursor loop live.
	const [autoJump, setAutoJumpState] = useState<boolean>(
		DEFAULT_ISLAND_AUTO_JUMP
	);
	useEffect(() => {
		let cancelled = false;
		const target = getTarget();
		getIslandAutoJump(target).then((value) => {
			if (!cancelled) {
				setAutoJumpState(value);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const handleAutoJump = (value: boolean) => {
		const previous = autoJump;
		setAutoJumpState(value);
		const target = getTarget();
		persistPreferenceChange(
			"island-auto-jump",
			setIslandAutoJump(target, value),
			() => setAutoJumpState(previous)
		);
	};

	// Hide-on-fullscreen. When on, the island hides itself while another app is
	// fullscreen (video, game, presentation) and returns when it exits. Stored in
	// Core; the island starts/stops its fullscreen poll loop live via SSE. Windows
	// only for now (the detection signal is a Win32 shell state).
	const [hideOnFullscreen, setHideOnFullscreenState] = useState<boolean>(
		DEFAULT_ISLAND_HIDE_ON_FULLSCREEN
	);
	useEffect(() => {
		let cancelled = false;
		const target = getTarget();
		getIslandHideOnFullscreen(target).then((value) => {
			if (!cancelled) {
				setHideOnFullscreenState(value);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const handleHideOnFullscreen = (value: boolean) => {
		const previous = hideOnFullscreen;
		setHideOnFullscreenState(value);
		const target = getTarget();
		persistPreferenceChange(
			"island-hide-on-fullscreen",
			setIslandHideOnFullscreen(target, value),
			() => setHideOnFullscreenState(previous)
		);
	};

	// Screen privacy. When on, the island is excluded from screen capture — still
	// visible to you, but omitted from screenshots, recordings, and screen-sharing.
	// Stored in Core; the island toggles `setContentProtection` live via SSE.
	const [screenPrivacy, setScreenPrivacyState] = useState<boolean>(
		DEFAULT_ISLAND_SCREEN_PRIVACY
	);
	useEffect(() => {
		let cancelled = false;
		const target = getTarget();
		getIslandScreenPrivacy(target).then((value) => {
			if (!cancelled) {
				setScreenPrivacyState(value);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const handleScreenPrivacy = (value: boolean) => {
		const previous = screenPrivacy;
		setScreenPrivacyState(value);
		const target = getTarget();
		persistPreferenceChange(
			"island-screen-privacy",
			setIslandScreenPrivacy(target, value),
			() => setScreenPrivacyState(previous)
		);
	};

	return {
		autoJump,
		handleAutoJump,
		handleHideOnFullscreen,
		handleIslandBg,
		handleIslandEdgeOffset,
		handleNotchMode,
		handleScreenPrivacy,
		hideOnFullscreen,
		islandBg,
		islandEdgeOffset,
		notchMode,
		screenPrivacy,
	};
}

export type IslandPlacementPrefsState = ReturnType<
	typeof useIslandPlacementPrefs
>;
