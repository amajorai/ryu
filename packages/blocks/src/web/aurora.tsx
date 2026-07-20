"use client";

import { Color, Mesh, Program, Renderer, Triangle } from "ogl";
import { useEffect, useMemo, useRef } from "react";

import "./aurora.css";

const MAX_COLOR_STOPS = 8;

const VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;

uniform float uTime;
uniform float uAmplitude;
uniform vec3 uColorStops[${MAX_COLOR_STOPS}];
uniform float uColorPositions[${MAX_COLOR_STOPS}];
uniform int uColorCount;
uniform vec2 uResolution;
uniform float uBlend;
uniform float uFan;

out vec4 fragColor;

vec3 permute(vec3 x) {
  return mod(((x * 34.0) + 1.0) * x, 289.0);
}

float snoise(vec2 v){
  const vec4 C = vec4(
      0.211324865405187, 0.366025403784439,
      -0.577350269189626, 0.024390243902439
  );
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);

  vec3 p = permute(
      permute(i.y + vec3(0.0, i1.y, 1.0))
    + i.x + vec3(0.0, i1.x, 1.0)
  );

  vec3 m = max(
      0.5 - vec3(
          dot(x0, x0),
          dot(x12.xy, x12.xy),
          dot(x12.zw, x12.zw)
      ),
      0.0
  );
  m = m * m;
  m = m * m;

  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);

  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

vec3 sampleColorRamp(float factor) {
  factor = clamp(factor, 0.0, 1.0);
  int count = uColorCount;
  if (count <= 1) {
    return uColorStops[0];
  }

  int idx = 0;
  for (int i = 0; i < ${MAX_COLOR_STOPS - 1}; i++) {
    if (i + 1 >= count) {
      break;
    }
    if (factor >= uColorPositions[i + 1]) {
      idx = i + 1;
    }
  }

  int nextIdx = idx + 1;
  if (nextIdx >= count) {
    return uColorStops[count - 1];
  }

  float pos0 = uColorPositions[idx];
  float pos1 = uColorPositions[nextIdx];
  float range = max(pos1 - pos0, 0.0001);
  float t = (factor - pos0) / range;
  return mix(uColorStops[idx], uColorStops[nextIdx], t);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;

  vec3 rampColor = sampleColorRamp(uv.x);

  float height = snoise(vec2(uv.x * 2.0 + uTime * 0.1, uTime * 0.25)) * 0.5 * uAmplitude;
  height = exp(height);

  // Parabolic fan: center stays low, left/right edges rise (smile curve along the bottom).
  float edgeDistance = abs(uv.x - 0.5) * 2.0;
  float fanCurve = pow(edgeDistance, 1.45);

  // Flip so the aurora rises from the bottom edge.
  height = ((1.0 - uv.y) * 1.55 - height + 0.12 + fanCurve * uFan);
  float intensity = 0.57 * height;

  float midPoint = 0.21;
  float auroraAlpha = smoothstep(midPoint - uBlend * 0.5, midPoint + uBlend * 0.5, intensity);

  // Fade via alpha only — don't multiply color by intensity or edges read as black.
  fragColor = vec4(rampColor * auroraAlpha, auroraAlpha);
}
`;

export interface AuroraColorStop {
	color: string;
	position: number;
}

type AuroraColorStopInput = string | AuroraColorStop;

interface AuroraProps {
	amplitude?: number;
	blend?: number;
	colorStops?: AuroraColorStopInput[];
	/** Lifts left/right edges and dips the center (0 = flat, ~0.5 = strong arc). */
	fan?: number;
	speed?: number;
	time?: number;
}

/** Brand landing gradient — all 8 stops with CSS gradient positions. */
export const FOOTER_AURORA_COLOR_STOPS: AuroraColorStop[] = [
	{ color: "#00FCB9", position: 0 }, // rgb(0, 252, 185)
	{ color: "#00BAF4", position: 0.14 }, // rgb(0, 186, 244)
	{ color: "#3780FF", position: 0.29 }, // rgb(55, 128, 255)
	{ color: "#7959FF", position: 0.43 }, // rgb(121, 89, 255)
	{ color: "#BB4DD9", position: 0.57 }, // rgb(187, 77, 217)
	{ color: "#EF5E92", position: 0.71 }, // rgb(239, 94, 146)
	{ color: "#FF883E", position: 0.86 }, // rgb(255, 136, 62)
	{ color: "#FFC500", position: 1 }, // rgb(255, 197, 0)
];

function toRgb(hex: string) {
	const c = new Color(hex);
	return [c.r, c.g, c.b] as [number, number, number];
}

function normalizeColorStops(stops: AuroraColorStopInput[]): AuroraColorStop[] {
	const normalized = stops.map((stop, index) => {
		if (typeof stop === "string") {
			const position = stops.length === 1 ? 0 : index / (stops.length - 1);
			return { color: stop, position };
		}
		return {
			color: stop.color,
			position:
				stop.position ?? (stops.length === 1 ? 0 : index / (stops.length - 1)),
		};
	});

	return normalized
		.slice(0, MAX_COLOR_STOPS)
		.toSorted((a, b) => a.position - b.position);
}

function packColorStops(stops: AuroraColorStop[]) {
	const colors = Array.from({ length: MAX_COLOR_STOPS }, () => [0, 0, 0]);
	const positions = Array.from({ length: MAX_COLOR_STOPS }, () => 0);

	for (const [index, stop] of stops.entries()) {
		colors[index] = toRgb(stop.color);
		positions[index] = stop.position;
	}

	return { colors, positions, count: stops.length };
}

export default function Aurora({
	colorStops = FOOTER_AURORA_COLOR_STOPS,
	amplitude = 0.2,
	blend = 1,
	fan = 0,
	speed = 1,
	time,
}: AuroraProps) {
	const ramp = useMemo(() => normalizeColorStops(colorStops), [colorStops]);
	const _rampKey = useMemo(
		() => ramp.map((stop) => `${stop.color}:${stop.position}`).join("|"),
		[ramp]
	);

	const propsRef = useRef({
		amplitude,
		blend,
		fan,
		ramp,
		speed,
		time,
	});
	propsRef.current = { amplitude, blend, fan, ramp, speed, time };

	const ctnDom = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const ctn = ctnDom.current;
		if (!ctn) {
			return;
		}

		const packed = packColorStops(ramp);

		const renderer = new Renderer({
			alpha: true,
			premultipliedAlpha: true,
			antialias: true,
		});
		const gl = renderer.gl;
		gl.clearColor(0, 0, 0, 0);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.canvas.style.backgroundColor = "transparent";

		let program: Program | undefined;

		function resize() {
			if (!ctn) {
				return;
			}
			const width = ctn.offsetWidth;
			const height = ctn.offsetHeight;
			renderer.setSize(width, height);
			if (program) {
				program.uniforms.uResolution.value = [width, height];
			}
		}
		window.addEventListener("resize", resize);
		const resizeObserver = new ResizeObserver(resize);
		resizeObserver.observe(ctn);

		const geometry = new Triangle(gl);
		if (geometry.attributes.uv) {
			geometry.attributes.uv = undefined;
		}

		program = new Program(gl, {
			vertex: VERT,
			fragment: FRAG,
			uniforms: {
				uTime: { value: 0 },
				uAmplitude: { value: amplitude },
				uColorStops: { value: packed.colors },
				uColorPositions: { value: packed.positions },
				uColorCount: { value: packed.count },
				uResolution: { value: [ctn.offsetWidth, ctn.offsetHeight] },
				uBlend: { value: blend },
				uFan: { value: fan },
			},
		});

		const mesh = new Mesh(gl, { geometry, program });
		ctn.appendChild(gl.canvas);

		let animateId = 0;
		const update = (t: number) => {
			animateId = requestAnimationFrame(update);
			if (!program) {
				return;
			}
			const { time = t * 0.01, speed = 1 } = propsRef.current;
			program.uniforms.uTime.value = time * speed * 0.1;
			program.uniforms.uAmplitude.value =
				propsRef.current.amplitude ?? amplitude;
			program.uniforms.uBlend.value = propsRef.current.blend ?? blend;
			program.uniforms.uFan.value = propsRef.current.fan ?? fan;

			const livePacked = packColorStops(propsRef.current.ramp);
			program.uniforms.uColorStops.value = livePacked.colors;
			program.uniforms.uColorPositions.value = livePacked.positions;
			program.uniforms.uColorCount.value = livePacked.count;

			renderer.render({ scene: mesh });
		};
		animateId = requestAnimationFrame(update);

		resize();

		return () => {
			cancelAnimationFrame(animateId);
			window.removeEventListener("resize", resize);
			resizeObserver.disconnect();
			if (ctn && gl.canvas.parentNode === ctn) {
				ctn.removeChild(gl.canvas);
			}
			gl.getExtension("WEBGL_lose_context")?.loseContext();
		};
	}, [amplitude, blend, ramp, fan]);

	return <div className="aurora-container" ref={ctnDom} />;
}
