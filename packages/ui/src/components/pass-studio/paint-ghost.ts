// The Ryu ghost mark the pass faces draw, with its animated eyes. Split from
// `paint.ts`, which re-exports it.

/**
 * The Ryu ghost, as the same 24-unit path `logo.tsx` builds. Copied rather than
 * imported because the component composes it from `scaleFactor` arithmetic
 * inside a render, with no exported d-string to reach — but it is byte-identical
 * to the `scaleFactor === 1` case, and to the path the OG raster carries.
 */
const GHOST_PATH_24 =
	"M12,24c9.2,0,12.9-4.8,12.4-14.6C24.1,0.3,12.8-3.7,8.8,5.4c-2.2,5.7,1.1,7.9-2.9,12.6c-0.9,1.1-1.8,2-2.7,3.1c-1.2,1.3,0.7,2.2,1.9,2.2C7.4,23.3,9.7,24,12,24z";
/** `logo.tsx`: eyes at (15,10) and (19,10), 1.5x3.0 in the 24-unit space... */
const EYE_LEFT_X = 15;
const EYE_RIGHT_X = 19;
const EYE_Y = 10;
const EYE_RX = 1.5;
const EYE_RY = 3;
/** ...capped in ABSOLUTE px once the mark is drawn large, exactly as the component caps them. */
const EYE_MAX_RX = 3;
const EYE_MAX_RY = 5;
/** `vector-effect: non-scaling-stroke` keeps the outline a 1.5 DEVICE-px hairline. */
const GHOST_STROKE_DEVICE_PX = 1.5;

/**
 * The mark's eyes, animated — the same two behaviours `logo.tsx` runs, replayed
 * from loop time instead of from timers.
 *
 * The component blinks on a `setInterval` of 3-5s and, once the mouse has been
 * idle for three seconds, drifts its gaze to a fresh random point every 2-4s. A
 * video has no mouse, so it is always in the idle-gaze state — but it also has to
 * LOOP, and a random walk driven by wall-clock timers cannot: the last frame
 * would not match the first, and the eyes would jump on every repeat. So the
 * gaze is a fixed keyframe ring that closes on itself and the blinks sit at fixed
 * offsets well clear of the seam.
 */
const GAZE_KEYS = [
	{ x: 0, y: 0 },
	{ x: 0.85, y: -0.45 },
	{ x: -0.75, y: 0.35 },
	{ x: 0.25, y: 0.7 },
] as const;
/** `min(size * 0.08, 8)` px in the component, which is 1.92 of the 24 units. */
const GAZE_MAX_UNITS = 1.92;
/** Seconds into the loop each blink starts, and how long it lasts. */
const BLINK_TIMES = [2.4, 6.9] as const;
const BLINK_SECONDS = 0.15;
/** How much of a keyframe's slot is spent travelling rather than holding. */
const GAZE_TRAVEL = 0.45;

export interface GhostEyes {
	blinking: boolean;
	/** Gaze offset in the mark's own 24-unit space. */
	gazeX: number;
	gazeY: number;
}

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/** The eye state at `time` seconds into a `loop`-second cycle. */
export function ghostEyesAt(time: number, loop: number): GhostEyes {
	const slot = loop / GAZE_KEYS.length;
	const index = Math.floor(time / slot) % GAZE_KEYS.length;
	const within = (time % slot) / slot;
	// Travel, then hold — the component's gaze snaps to a point and rests there,
	// so easing across the whole slot would read as a constant slow drift.
	const eased = smoothstep(Math.min(1, within / GAZE_TRAVEL));
	const from = GAZE_KEYS[index] ?? GAZE_KEYS[0];
	const to = GAZE_KEYS[(index + 1) % GAZE_KEYS.length] ?? GAZE_KEYS[0];
	return {
		blinking: BLINK_TIMES.some((at) => time >= at && time < at + BLINK_SECONDS),
		gazeX: (from.x + (to.x - from.x) * eased) * GAZE_MAX_UNITS,
		gazeY: (from.y + (to.y - from.y) * eased) * GAZE_MAX_UNITS,
	};
}

let ghostPath: Path2D | null = null;
const ghost = (): Path2D => {
	ghostPath ??= new Path2D(GHOST_PATH_24);
	return ghostPath;
};

/**
 * Draw the mark at `size` CSS px with its top-left at (x, y).
 *
 * `scale` is the supersample factor the whole face is drawn at. It is taken
 * separately from `size` because the stroke must NOT scale with it: on screen
 * the outline is a non-scaling 1.5px hairline, so at 3x supersample it is 4.5
 * device px — the same hairline, not a mark three times as heavy.
 */
export function drawGhost(
	ctx: CanvasRenderingContext2D,
	{
		color,
		eyes,
		scale,
		size,
		x,
		y,
	}: {
		color: string;
		/** Omit for the resting mark, which is what the card's own faces wear. */
		eyes?: GhostEyes;
		scale: number;
		size: number;
		x: number;
		y: number;
	}
): void {
	const unit = (size / 24) * scale;
	ctx.save();
	ctx.translate(x * scale, y * scale);
	ctx.scale(unit, unit);
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.lineWidth = (GHOST_STROKE_DEVICE_PX * scale) / unit;
	ctx.stroke(ghost());
	const rx = Math.min(EYE_RX * unit, EYE_MAX_RX * scale) / unit;
	const ry = Math.min(EYE_RY * unit, EYE_MAX_RY * scale) / unit;
	const gazeX = eyes?.gazeX ?? 0;
	const gazeY = eyes?.gazeY ?? 0;
	if (eyes?.blinking) {
		// A blink is a closed lid, which the component draws as a stroked line
		// across the eye rather than a squashed ellipse — the same shape here.
		const lid = Math.min(Math.max(2 * unit, 1), 4) * scale;
		ctx.lineWidth = lid / unit;
		for (const cx of [EYE_LEFT_X, EYE_RIGHT_X]) {
			ctx.beginPath();
			ctx.moveTo(cx + gazeX - rx, EYE_Y + gazeY);
			ctx.lineTo(cx + gazeX + rx, EYE_Y + gazeY);
			ctx.stroke();
		}
		ctx.restore();
		return;
	}
	for (const cx of [EYE_LEFT_X, EYE_RIGHT_X]) {
		ctx.beginPath();
		ctx.ellipse(cx + gazeX, EYE_Y + gazeY, rx, ry, 0, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.restore();
}

/** The colours the face is printed in, resolved from the live theme tokens. */
