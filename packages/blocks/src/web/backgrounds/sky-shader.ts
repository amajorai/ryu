import {
	BACKDROP_CONTEXT_ATTRIBUTES,
	createFrameLoop,
	prefersReducedMotion,
} from "./webgl-gate.ts";

/*
 * Ryu's own drifting-cloud sky (not vendored): a vertical sky gradient under a
 * layer of domain-warped fbm clouds that recede toward the horizon and drift
 * with the wind. Each cloud is shaded from its lit top to its underside. The
 * hero blurs it heavily, so it renders at half resolution and the noise stays
 * cheap. Sleeps off screen and in hidden tabs, and draws one still frame under
 * reduced motion.
 */

/** Zenith, horizon, cloud, and cloud shade, as `#rrggbb`. */
export type SkyShaderPalette = readonly [string, string, string, string];

export interface SkyShader {
	setPalette(palette: SkyShaderPalette): void;
	stop(): void;
}

// The CSS blur hides detail, so half the CSS pixel grid is plenty.
const RENDER_SCALE = 0.5;
// Seconds of drift per second; the deck crosses the hero in under a minute.
const DRIFT_SPEED = 1;

const VERTEX = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT = `
precision mediump float;

uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_zenith;
uniform vec3 u_horizon;
uniform vec3 u_cloud;
uniform vec3 u_shade;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  mat2 turn = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    value += amplitude * noise(p);
    p = turn * p * 2.02 + 1.7;
    amplitude *= 0.5;
  }
  return value;
}

// Warping the field by itself turns blobs into billows.
float cloudField(vec2 p, float t) {
  vec2 warp = vec2(
    fbm(p + vec2(0.0, t * 0.05)),
    fbm(p + vec2(5.2, 1.3) - t * 0.03)
  );
  return fbm(p + 1.6 * warp + vec2(t * 0.12, 0.0));
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);

  // Deep at the zenith, pale toward the horizon.
  vec3 sky = mix(u_horizon, u_zenith, smoothstep(0.0, 1.0, uv.y));

  // A tilted cloud deck: rows near the bottom are farther away, so their
  // clouds are narrower there. Only x is scaled, so rows never fold over.
  float depth = mix(1.9, 1.0, uv.y);
  vec2 p = vec2((uv.x - 0.5) * aspect * depth, uv.y * 1.4) * 2.6;
  float density = cloudField(p, u_time);
  float cover = smoothstep(0.4, 0.7, density);

  // Lit from above: compare with the field a little higher up.
  float above = cloudField(p + vec2(0.0, 0.07), u_time);
  float lit = clamp((density - above) * 4.0 + 0.62, 0.0, 1.0);
  vec3 cloud = mix(u_shade, u_cloud, lit);

  // Distant clouds fade into the horizon haze.
  cloud = mix(cloud, u_horizon, (1.0 - uv.y) * 0.35);
  gl_FragColor = vec4(mix(sky, cloud, cover * 0.95), 1.0);
}
`;

const UNIFORM_COLORS = ["u_zenith", "u_horizon", "u_cloud", "u_shade"] as const;

function hexToRgb(hex: string): [number, number, number] {
	const value = Number.parseInt(hex.replace("#", ""), 16);
	if (Number.isNaN(value)) {
		return [0.5, 0.7, 0.9];
	}
	// biome-ignore lint/suspicious/noBitwiseOperators: unpacking an RGB hex.
	return [
		((value >> 16) & 255) / 255,
		((value >> 8) & 255) / 255,
		(value & 255) / 255,
	];
}

function compile(
	gl: WebGLRenderingContext,
	type: number,
	source: string
): WebGLShader | null {
	const shader = gl.createShader(type);
	if (!shader) {
		return null;
	}
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		return shader;
	}
	gl.deleteShader(shader);
	return null;
}

function linkProgram(gl: WebGLRenderingContext): WebGLProgram | null {
	const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
	const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
	const program = gl.createProgram();
	if (!(vertex && fragment && program)) {
		return null;
	}
	gl.attachShader(program, vertex);
	gl.attachShader(program, fragment);
	gl.linkProgram(program);
	// The program keeps the compiled stages alive on its own.
	gl.deleteShader(vertex);
	gl.deleteShader(fragment);
	if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
		return program;
	}
	gl.deleteProgram(program);
	return null;
}

/**
 * Draws the sky into `canvas`, sized to the canvas's CSS box. Returns null when
 * the browser has no hardware WebGL, leaving whatever is behind the canvas.
 */
export function startSkyShader(
	canvas: HTMLCanvasElement,
	initialPalette: SkyShaderPalette
): SkyShader | null {
	const gl = canvas.getContext("webgl", BACKDROP_CONTEXT_ATTRIBUTES);
	const program = gl ? linkProgram(gl) : null;
	if (!(gl && program)) {
		return null;
	}
	gl.useProgram(program);
	const buffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(
		gl.ARRAY_BUFFER,
		new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
		gl.STATIC_DRAW
	);
	const position = gl.getAttribLocation(program, "a_position");
	gl.enableVertexAttribArray(position);
	gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

	const resolution = gl.getUniformLocation(program, "u_resolution");
	const time = gl.getUniformLocation(program, "u_time");
	const colors = UNIFORM_COLORS.map((name) =>
		gl.getUniformLocation(program, name)
	);
	const setPalette = (palette: SkyShaderPalette) => {
		colors.forEach((location, index) => {
			gl.uniform3fv(location, hexToRgb(palette[index] ?? "#ffffff"));
		});
	};
	setPalette(initialPalette);

	const resize = () => {
		const width = Math.max(1, Math.round(canvas.clientWidth * RENDER_SCALE));
		const height = Math.max(1, Math.round(canvas.clientHeight * RENDER_SCALE));
		if (canvas.width !== width || canvas.height !== height) {
			canvas.width = width;
			canvas.height = height;
			gl.viewport(0, 0, width, height);
		}
	};

	// The clock only runs while frames are drawn, so a resume picks up where
	// the sky left off instead of jumping.
	let clock = 0;
	let last = 0;
	const still = prefersReducedMotion();
	const loop = createFrameLoop(
		canvas,
		(now) => {
			clock += last ? Math.min(0.1, (now - last) / 1000) * DRIFT_SPEED : 0;
			last = now;
			resize();
			gl.uniform2f(resolution, canvas.width, canvas.height);
			gl.uniform1f(time, clock);
			gl.drawArrays(gl.TRIANGLES, 0, 6);
			return true;
		},
		{ still }
	);
	const observer =
		typeof ResizeObserver === "undefined"
			? null
			: new ResizeObserver(() => loop.wake());
	observer?.observe(canvas);

	return {
		setPalette: (palette) => {
			setPalette(palette);
			loop.wake();
		},
		stop: () => {
			loop.stop();
			observer?.disconnect();
			gl.deleteBuffer(buffer);
			gl.deleteProgram(program);
		},
	};
}
