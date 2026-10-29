"use client";

// The libraries.dev voice glow (`voice-glow`'s `VoiceBeam`), used as-is around a
// live voice call surface: a colorful glow along the wrapped element's bottom
// edge that rises and blooms with the voice. This wrapper only adapts Ryu's
// voice state to it — the rolling mic level history becomes `level`, and the
// assistant "thinking" state gathers the lobes into one beam that sweeps the
// edge through the package's public `motion` prop.

import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
	VoiceBeam,
	type VoiceBeamMotion,
	type VoiceBeamType,
} from "voice-glow";

const SWEEP_PERIOD_MS = 1400;
/** Per-frame easing toward the gathered/released beam (~0.25s at 60fps). */
const GATHER_EASE = 0.12;

export interface VoiceGlowProps {
	/** Whether the glow listens; false fades it out (connecting, muted). */
	active?: boolean;
	children: ReactNode;
	className?: string;
	/** Rolling mic RMS values, oldest-to-newest. */
	levels: readonly number[];
	/** Gather the glow into a sweeping beam while the assistant is thinking. */
	processing?: boolean;
	/**
	 * Match the host surface; defaults to the nearest `.dark` / `.light` scope
	 * around the glow (e.g. the Island notch's forced-dark surface), falling
	 * back to the document's `dark` class.
	 */
	theme?: "auto" | "dark" | "light";
	/** `voice-glow` host preset. */
	type?: VoiceBeamType;
}

const CLASS_MUTATIONS: MutationObserverInit = {
	attributeFilter: ["class"],
	attributes: true,
};

function documentTheme(): "dark" | "light" {
	return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * The theme of the surface `host` sits on: its nearest `.dark` / `.light`
 * scope, falling back to <html>. Ryu themes apps by toggling `dark` on <html>,
 * but some surfaces force their own scope — the Island notch is always a black
 * `.dark` surface, whatever the app theme — and the glow must match the
 * surface it actually draws on.
 */
export function resolveHostTheme(host: Element | null): "dark" | "light" {
	const scope = host?.closest(".dark, .light");
	if (scope) {
		return scope.classList.contains("dark") ? "dark" : "light";
	}
	return documentTheme();
}

/**
 * Track the host's theme scope. The ancestors (and <html>) are observed for
 * class changes, so both an app theme switch and a scope toggled around the
 * glow re-resolve it.
 */
function useHostTheme(
	hostRef: RefObject<HTMLDivElement | null>
): "dark" | "light" {
	const subscribe = useCallback(
		(onChange: () => void) => {
			const observer = new MutationObserver(onChange);
			const root = document.documentElement;
			observer.observe(root, CLASS_MUTATIONS);
			let node = hostRef.current?.parentElement ?? null;
			while (node && node !== root) {
				observer.observe(node, CLASS_MUTATIONS);
				node = node.parentElement;
			}
			return () => observer.disconnect();
		},
		[hostRef]
	);
	const getSnapshot = useCallback(
		() => resolveHostTheme(hostRef.current),
		[hostRef]
	);
	return useSyncExternalStore(subscribe, getSnapshot, () => "dark");
}

function latestLevel(levels: readonly number[]): number {
	let peak = 0;
	for (const level of levels.slice(-3)) {
		if (Number.isFinite(level)) {
			peak = Math.max(peak, Math.min(1, Math.max(0, level)));
		}
	}
	return peak;
}

export function VoiceGlow({
	active = true,
	children,
	className,
	levels,
	processing = false,
	theme,
	type,
}: VoiceGlowProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const hostTheme = useHostTheme(hostRef);
	const levelRef = useRef(0);
	const processingRef = useRef(processing);
	const gatherRef = useRef(0);
	useEffect(() => {
		levelRef.current = latestLevel(levels);
	}, [levels]);
	useEffect(() => {
		processingRef.current = processing;
	}, [processing]);

	// Sampled by the voice-glow driver every frame without re-rendering.
	const readLevel = useCallback(() => levelRef.current, []);
	const readMotion = useCallback((): VoiceBeamMotion | null => {
		const target = processingRef.current ? 1 : 0;
		gatherRef.current += (target - gatherRef.current) * GATHER_EASE;
		if (gatherRef.current < 0.01) {
			gatherRef.current = 0;
			return null;
		}
		const phase = (performance.now() % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS;
		return {
			gather: gatherRef.current,
			heldLevel: 0.55,
			offset: Math.sin(phase * Math.PI * 2) * 0.8,
			stretch: 0.4,
		};
	}, []);

	return (
		<VoiceBeam
			active={active}
			className={className}
			data-processing={processing}
			level={readLevel}
			motion={readMotion}
			ref={hostRef}
			theme={theme ?? hostTheme}
			type={type}
		>
			{children}
		</VoiceBeam>
	);
}
