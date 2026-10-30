import type { MotionStyle, MotionValue } from "motion/react";

export const CELL = {
	type: "spring",
	stiffness: 520,
	damping: 34,
	mass: 0.45,
} as const;

export const HOME = {
	type: "spring",
	stiffness: 150,
	damping: 27,
	mass: 1,
} as const;

export const VEIL = {
	type: "spring",
	stiffness: 260,
	damping: 34,
	mass: 0.8,
} as const;

export const EASE = [0.23, 1, 0.32, 1] as const;
export const EXIT = { duration: 0.2, ease: [0.4, 0, 1, 1] } as const;

export const TOGGLE = 2.5;
export const CONTROL_ZOOM_STEP = 0.25;
export const KEY_ZOOM = 1.6;
export const KEY_PAN = 56;
export const WHEEL_RATE = 140;
export const SLOP = 8;
export const NEAR_HOME = 1.02;
export const SNAP_HOME = 1.05;

/** Motion supports CSS variable bindings; these owner contracts declare the numeric
 * spring carriers absent from React's closed CSSProperties key set. */
export interface ImageViewerFlightStyle extends MotionStyle {
	"--image-viewer-flight-opacity": MotionValue<number>;
	"--image-viewer-flight-scale": MotionValue<number>;
	"--image-viewer-flight-transform": MotionValue<string>;
	"--image-viewer-flight-x": MotionValue<number>;
	"--image-viewer-flight-y": MotionValue<number>;
}
export interface ImageViewerContentStyle extends MotionStyle {
	"--image-viewer-content-radius": MotionValue<number>;
	"--image-viewer-content-scale": MotionValue<number>;
	"--image-viewer-content-transform": MotionValue<string>;
	"--image-viewer-content-x": MotionValue<number>;
	"--image-viewer-content-y": MotionValue<number>;
}

export interface Spring {
	damping: number;
	mass: number;
	stiffness: number;
	type: "spring";
}

export const clamp = (v: number, lo: number, hi: number) =>
	Math.min(hi, Math.max(lo, v));
