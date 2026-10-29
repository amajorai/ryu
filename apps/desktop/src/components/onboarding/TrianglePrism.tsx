import { isSoftwareWebglRenderer } from "@ryu/ui/components/motion/prism-gradient.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useRef, useState } from "react";

// A raymarched, glowing triangular prism, adapted from the React Bits "Prism"
// background (reactbits.dev, @react-bits registry). Trimmed to the rotating
// variant the onboarding backdrop uses: no palette texture, light-mode ink,
// pointer tilt or offset.

export interface TrianglePrismProps {
	/** Keep spinning. False renders one still frame. */
	animate?: boolean;
	/** Width of the prism's triangular base, in scene units. */
	baseWidth?: number;
	className?: string;
	/** How tightly the colour bands repeat along the prism. */
	colorFrequency?: number;
	/** Overall brightness of the glow. */
	glow?: number;
	/** Height of the prism, in scene units. */
	height?: number;
	/** Hue rotation in degrees. */
	hueShift?: number;
	/** Film-grain amount (0 disables it). */
	noise?: number;
	/** Canvas resolution relative to the device pixel ratio (0.25 to 1). */
	resolution?: number;
	saturation?: number;
	/** Zoom: larger values draw a smaller prism. */
	scale?: number;
	/** Rotation speed. */
	timeScale?: number;
}

const INTRO_SECONDS = 1.4;
const HUE_W = [0.299, 0.587, 0.114, 0.299, 0.587, 0.114, 0.299, 0.587, 0.114];
const HUE_U = [
	0.701, -0.587, -0.114, -0.299, 0.413, -0.114, -0.3, -0.588, 0.886,
];
const HUE_V = [0.168, -0.331, 0.5, 0.328, 0.035, -0.5, -0.497, 0.296, 0.201];

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform mat3 uRay;
uniform float uGlow;
uniform float uColorFreq;
uniform float uCenterShift;
uniform float uInvBaseHalf;
uniform float uInvHeight;
uniform float uMinAxis;
uniform float uPxScale;
uniform float uTime;
uniform float uNoise;
uniform float uSaturation;
uniform mat3 uHue;
uniform int uUseHue;
out vec4 outColor;

const vec4 PHASE_COS = vec4(1.0, 0.5403023058681398, -0.4161468365471424, -0.9899924966004454);
const vec4 PHASE_SIN = vec4(0.0, 0.8414709848078965, 0.9092974268256817, 0.1411200080598672);

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453123);
}

float pyramid(vec3 p) {
  vec3 q = vec3(abs(p.x) * uInvBaseHalf, abs(p.y) * uInvHeight, abs(p.z) * uInvBaseHalf);
  return max((q.x + q.y + q.z - 1.0) * uMinAxis * 0.5773502691896258, -p.y);
}

void main() {
  vec2 f = (gl_FragCoord.xy - 0.5 * uResolution) * uPxScale;
  vec3 origin = uRay * vec3(f, 0.0);
  vec3 axis = uRay[2];
  float z = 5.0;
  vec4 o = vec4(0.0);
  for (int i = 0; i < 100; i++) {
    vec3 p = origin + axis * z;
    float d = 0.1 + 0.2 * abs(pyramid(p + vec3(0.0, uCenterShift, 0.0)));
    z -= d;
    float phase = (p.y + z) * uColorFreq;
    o += (sin(phase) * PHASE_COS + cos(phase) * PHASE_SIN + 1.0) / d;
  }
  vec4 raw = o * o * uGlow / 1e5;
  vec4 e = exp(2.0 * raw);
  vec4 mapped = (e - 1.0) / (e + 1.0);
  vec3 col = mapped.rgb + (rand(gl_FragCoord.xy + vec2(uTime)) - 0.5) * uNoise;
  col = clamp(col, 0.0, 1.0);
  float L = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = clamp(mix(vec3(L), col, uSaturation), 0.0, 1.0);
  if (uUseHue == 1) col = clamp(uHue * col, 0.0, 1.0);
  outColor = vec4(col * mapped.a, mapped.a);
}`;

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));

function compileShader(
	gl: WebGL2RenderingContext,
	type: number,
	source: string
) {
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

function linkProgram(gl: WebGL2RenderingContext) {
	const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX);
	const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT);
	const program = gl.createProgram();
	if (!(vertex && fragment && program)) {
		return null;
	}
	gl.attachShader(program, vertex);
	gl.attachShader(program, fragment);
	gl.linkProgram(program);
	gl.deleteShader(vertex);
	gl.deleteShader(fragment);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		gl.deleteProgram(program);
		return null;
	}
	return program;
}

function rendererName(gl: WebGL2RenderingContext): string | null {
	try {
		const info = gl.getExtension("WEBGL_debug_renderer_info");
		const renderer: unknown = gl.getParameter(
			info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER
		);
		return typeof renderer === "string" ? renderer : null;
	} catch {
		return null;
	}
}

// Column-major 3x3: a spin about the prism's vertical axis.
function spin(time: number) {
	const c0 = Math.cos(time);
	const c1 = Math.cos(time + 33);
	const c2 = Math.cos(time + 11);
	return [c0, 0, c2, 0, 1, 0, c1, 0, c0];
}

export function TrianglePrism({
	animate = true,
	baseWidth = 5.5,
	className,
	colorFrequency = 1,
	glow = 1,
	height = 3.5,
	hueShift = 0,
	noise = 0,
	resolution = 0.5,
	saturation = 1.5,
	scale = 3.6,
	timeScale = 0.5,
}: TrianglePrismProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const settings = {
		animate,
		baseWidth: Math.max(0.1, baseWidth),
		colorFrequency: Math.max(0, colorFrequency),
		glow: Math.max(0, glow),
		height: Math.max(0.1, height),
		hueShift: (hueShift * Math.PI) / 180,
		noise: Math.max(0, noise),
		resolution: clamp(resolution, 0.25, 1),
		saturation: Math.max(0, saturation),
		scale: Math.max(0.1, scale),
		timeScale: Math.max(0, timeScale),
	};
	const settingsRef = useRef(settings);
	settingsRef.current = settings;
	const wakeRef = useRef<(() => void) | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		if (failed) {
			return;
		}
		const container = containerRef.current;
		const canvas = canvasRef.current;
		const gl = canvas?.getContext("webgl2", {
			alpha: true,
			premultipliedAlpha: true,
			antialias: false,
			depth: false,
			stencil: false,
		});
		if (!(container && canvas && gl)) {
			setFailed(true);
			return;
		}
		const program = linkProgram(gl);
		if (!program) {
			setFailed(true);
			return;
		}
		const uniform = (name: string) => gl.getUniformLocation(program, name);
		const u = {
			resolution: uniform("uResolution"),
			ray: uniform("uRay"),
			glow: uniform("uGlow"),
			colorFreq: uniform("uColorFreq"),
			centerShift: uniform("uCenterShift"),
			invBaseHalf: uniform("uInvBaseHalf"),
			invHeight: uniform("uInvHeight"),
			minAxis: uniform("uMinAxis"),
			pxScale: uniform("uPxScale"),
			time: uniform("uTime"),
			noise: uniform("uNoise"),
			saturation: uniform("uSaturation"),
			hue: uniform("uHue"),
			useHue: uniform("uUseHue"),
		};
		const vao = gl.createVertexArray();

		// A 100-step raymarch per pixel is far too heavy for a CPU rasterizer
		// (SwiftShader, llvmpipe, WARP); there it renders one still frame, the
		// same as with reduced motion.
		const still = isSoftwareWebglRenderer(rendererName(gl));
		let time = 0;
		let introClock = still ? 1 : 0;
		let raf = 0;
		let last = 0;
		let visible = true;

		const draw = () => {
			const s = settingsRef.current;
			const half = s.baseWidth * 0.5;
			const ignite = introClock * introClock * (3 - 2 * introClock);
			const cos = Math.cos(s.hueShift);
			const sin = Math.sin(s.hueShift);
			gl.bindVertexArray(vao);
			gl.viewport(0, 0, canvas.width, canvas.height);
			gl.useProgram(program);
			gl.uniform2f(u.resolution, canvas.width, canvas.height);
			gl.uniformMatrix3fv(u.ray, false, spin(time * s.timeScale));
			gl.uniform1f(u.glow, s.glow * ignite * ignite);
			gl.uniform1f(u.colorFreq, s.colorFrequency);
			gl.uniform1f(u.centerShift, s.height * 0.25);
			gl.uniform1f(u.invBaseHalf, 1 / half);
			gl.uniform1f(u.invHeight, 1 / s.height);
			gl.uniform1f(u.minAxis, Math.min(half, s.height));
			gl.uniform1f(u.pxScale, 1 / (canvas.height * 0.1 * s.scale));
			gl.uniform1f(u.time, time);
			gl.uniform1f(u.noise, s.noise);
			gl.uniform1f(u.saturation, s.saturation);
			gl.uniformMatrix3fv(
				u.hue,
				false,
				HUE_W.map((w, i) => w + HUE_U[i] * cos + HUE_V[i] * sin)
			);
			gl.uniform1i(u.useHue, Math.abs(s.hueShift) > 0.0001 ? 1 : 0);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		};

		const frame = (now: number) => {
			raf = 0;
			if (!visible || document.hidden) {
				return;
			}
			const s = settingsRef.current;
			const moving = s.animate && !still;
			const dt = last ? clamp((now - last) / 1000, 0.001, 0.05) : 1 / 60;
			last = now;
			if (moving) {
				time += dt;
			}
			if (introClock < 1) {
				introClock = moving ? Math.min(1, introClock + dt / INTRO_SECONDS) : 1;
			}
			draw();
			if ((moving && s.timeScale > 0) || introClock < 1) {
				raf = requestAnimationFrame(frame);
			} else {
				last = 0;
			}
		};

		const wake = () => {
			if (!raf && visible && !document.hidden) {
				raf = requestAnimationFrame(frame);
			}
		};

		const resize = () => {
			const s = settingsRef.current;
			const pixelScale =
				Math.min(window.devicePixelRatio || 1, 2) * s.resolution;
			canvas.width = Math.max(
				1,
				Math.round(container.clientWidth * pixelScale)
			);
			canvas.height = Math.max(
				1,
				Math.round(container.clientHeight * pixelScale)
			);
			draw();
			wake();
		};

		const onVisibility = () => {
			last = 0;
			wake();
		};

		const resizeObserver = new ResizeObserver(resize);
		resizeObserver.observe(container);
		const intersection = new IntersectionObserver((entries) => {
			visible = entries.some((entry) => entry.isIntersecting);
			if (visible) {
				last = 0;
				wake();
			}
		});
		intersection.observe(container);
		document.addEventListener("visibilitychange", onVisibility);
		const onContextLost = (event: Event) => {
			event.preventDefault();
			cancelAnimationFrame(raf);
			raf = 0;
			setFailed(true);
		};
		canvas.addEventListener("webglcontextlost", onContextLost, { once: true });
		resize();
		wakeRef.current = wake;

		return () => {
			cancelAnimationFrame(raf);
			wakeRef.current = null;
			resizeObserver.disconnect();
			intersection.disconnect();
			document.removeEventListener("visibilitychange", onVisibility);
			canvas.removeEventListener("webglcontextlost", onContextLost);
			gl.deleteVertexArray(vao);
			gl.deleteProgram(program);
		};
	}, [failed]);

	// Settings live in a ref, so a prop change only needs a redraw.
	useEffect(() => {
		wakeRef.current?.();
	});

	return (
		<div
			className={cn("relative size-full overflow-hidden", className)}
			ref={containerRef}
		>
			{failed ? (
				<div
					className="absolute inset-0"
					data-testid="triangle-prism-fallback"
					style={{
						backgroundImage:
							"radial-gradient(circle at 50% 55%, rgba(102, 179, 255, 0.35) 0%, rgba(5, 5, 5, 0) 60%)",
					}}
				/>
			) : (
				<canvas className="absolute inset-0 block size-full" ref={canvasRef} />
			)}
		</div>
	);
}
