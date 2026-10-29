// Canvas drawings for the seasonal particles. Each draws at the origin; the
// caller has already translated to the particle and set its fill color.

export type ParticleShape =
	| "dot"
	| "flake"
	| "confetti"
	| "ghost"
	| "egg"
	| "heart"
	| "petal"
	| "packet";

const GOLD = "#facc15";

/** A soft snowflake: a dot that fades out at its edge. */
function drawFlake(ctx: CanvasRenderingContext2D, size: number) {
	ctx.shadowBlur = size * 2;
	ctx.shadowColor = ctx.fillStyle as string;
	ctx.beginPath();
	ctx.arc(0, 0, size, 0, Math.PI * 2);
	ctx.fill();
}

/** A paper strip that flips as it tumbles. */
function drawConfetti(
	ctx: CanvasRenderingContext2D,
	size: number,
	rotation: number,
	phase: number
) {
	ctx.rotate(rotation);
	ctx.scale(1, Math.cos(phase * 2));
	ctx.fillRect(-size / 2, -size * 0.3, size, size * 0.6);
}

// Floaty sheet ghost: round head, sides that flare out and a hem that ripples.
function drawGhost(ctx: CanvasRenderingContext2D, size: number, phase: number) {
	const w = size;
	const h = size * 1.4;
	const flare = w * 0.62;
	ctx.rotate(Math.cos(phase) * 0.22);
	ctx.beginPath();
	ctx.moveTo(-w / 2, 0);
	ctx.arc(0, 0, w / 2, Math.PI, 0);
	ctx.bezierCurveTo(w / 2, h * 0.35, flare, h * 0.55, flare, h * 0.8);
	const waves = 4;
	const step = (flare * 2) / waves;
	for (let i = 0; i < waves; i++) {
		const startX = flare - step * i;
		const ripple = Math.sin(phase * 3 + i * 1.7) * size * 0.08;
		const dip = i % 2 === 0 ? size * 0.22 : size * 0.12;
		ctx.quadraticCurveTo(
			startX - step / 2,
			h * 0.8 - dip + ripple,
			startX - step,
			h * 0.8 + ripple * 0.5
		);
	}
	ctx.bezierCurveTo(-flare, h * 0.55, -w / 2, h * 0.35, -w / 2, 0);
	ctx.closePath();
	ctx.fill();

	// Eyes and a little "oo" mouth punched out of the sheet.
	ctx.globalCompositeOperation = "destination-out";
	const holes: [number, number, number, number, number][] = [
		[-w * 0.17, -w * 0.02, w * 0.075, w * 0.11, -0.15],
		[w * 0.17, -w * 0.02, w * 0.075, w * 0.11, 0.15],
		[0, w * 0.22, w * 0.06, w * 0.08, 0],
	];
	for (const [x, y, rx, ry, rotation] of holes) {
		ctx.beginPath();
		ctx.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2);
		ctx.fill();
	}
}

function drawEgg(ctx: CanvasRenderingContext2D, size: number, tilt: number) {
	const w = size * 0.8;
	const h = size;
	ctx.rotate(tilt);
	ctx.beginPath();
	// Narrower on top, rounder at the bottom.
	ctx.moveTo(0, -h);
	ctx.bezierCurveTo(w, -h, w, h, 0, h);
	ctx.bezierCurveTo(-w, h, -w, -h, 0, -h);
	ctx.fill();
	// A white zigzag band like a painted egg.
	ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
	ctx.lineWidth = Math.max(1, size * 0.14);
	ctx.beginPath();
	const zigs = 4;
	for (let i = 0; i <= zigs; i++) {
		const x = -w * 0.68 + (w * 1.36 * i) / zigs;
		const y = i % 2 === 0 ? -size * 0.08 : size * 0.12;
		if (i === 0) {
			ctx.moveTo(x, y);
		} else {
			ctx.lineTo(x, y);
		}
	}
	ctx.stroke();
}

function drawHeart(ctx: CanvasRenderingContext2D, size: number, phase: number) {
	ctx.rotate(Math.sin(phase) * 0.25);
	ctx.beginPath();
	ctx.moveTo(0, size * 0.35);
	ctx.bezierCurveTo(
		-size * 1.1,
		-size * 0.35,
		-size * 0.45,
		-size * 1.05,
		0,
		-size * 0.4
	);
	ctx.bezierCurveTo(
		size * 0.45,
		-size * 1.05,
		size * 1.1,
		-size * 0.35,
		0,
		size * 0.35
	);
	ctx.fill();
}

function drawPetal(
	ctx: CanvasRenderingContext2D,
	size: number,
	rotation: number
) {
	ctx.rotate(rotation);
	ctx.beginPath();
	ctx.ellipse(0, 0, size * 0.5, size, 0, 0, Math.PI * 2);
	ctx.fill();
}

/** A red packet (hongbao) with a gold flap and coin. */
function drawPacket(ctx: CanvasRenderingContext2D, size: number, tilt: number) {
	const w = size;
	const h = size * 1.35;
	ctx.rotate(tilt * 0.3);
	ctx.beginPath();
	ctx.roundRect(-w / 2, -h / 2, w, h, size * 0.15);
	ctx.fill();
	ctx.fillStyle = GOLD;
	ctx.beginPath();
	ctx.moveTo(-w / 2, -h / 2 + h * 0.18);
	ctx.quadraticCurveTo(0, -h / 2 + h * 0.42, w / 2, -h / 2 + h * 0.18);
	ctx.lineTo(w / 2, -h / 2 + h * 0.24);
	ctx.quadraticCurveTo(0, -h / 2 + h * 0.48, -w / 2, -h / 2 + h * 0.24);
	ctx.fill();
	ctx.beginPath();
	ctx.arc(0, h * 0.08, size * 0.16, 0, Math.PI * 2);
	ctx.fill();
}

export function drawParticle(
	ctx: CanvasRenderingContext2D,
	shape: ParticleShape,
	size: number,
	phase: number,
	rotation: number
): void {
	switch (shape) {
		case "flake":
			drawFlake(ctx, size);
			return;
		case "confetti":
			drawConfetti(ctx, size, rotation, phase);
			return;
		case "ghost":
			drawGhost(ctx, size, phase);
			return;
		case "egg":
			drawEgg(ctx, size, Math.sin(phase) * 0.5);
			return;
		case "heart":
			drawHeart(ctx, size, phase);
			return;
		case "petal":
			drawPetal(ctx, size, rotation);
			return;
		case "packet":
			drawPacket(ctx, size, Math.sin(phase));
			return;
		default:
			ctx.beginPath();
			ctx.arc(0, 0, size, 0, Math.PI * 2);
			ctx.fill();
	}
}
