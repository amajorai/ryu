/* eslint-disable react/no-unknown-property */
import { useFBO } from "@react-three/drei";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type { Mesh, Scene, ShaderMaterial } from "three";
import { useBoundUniforms } from "./game3d-materials.tsx";

/**
 * Renders the scene through a bloom chain. The scene is drawn in linear HDR
 * into an offscreen target; only what is brighter than the threshold glows
 * (the sun or moon disk, lit windows, lanterns, fireflies, sparkles and the
 * strongest rim highlights). Bright parts are blurred at a quarter and an
 * eighth of the resolution, added back, then ACES tone mapping and sRGB
 * output are applied once, as the result reaches the screen.
 *
 * Taking over the render loop (a positive `useFrame` priority) also keeps
 * the off-center view shift and the name plates in sync, since both are
 * applied to the camera before this runs.
 *
 * Built from drei's `useFBO` and one full-screen quad, so no runtime import
 * of three is needed (see game3d-math.ts).
 */

/** Linear luminance where blooming starts, and the soft knee above it. */
const THRESHOLD = 1.25;
const KNEE = 0.3;
/** HalfFloatType: HDR targets, so values above 1 survive to the bloom. */
const HALF_FLOAT = 1016;

const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** One shader for every step, picked by `uMode`. */
const QUAD_FRAGMENT = /* glsl */ `
uniform sampler2D tInput;
uniform sampler2D tBloomA;
uniform sampler2D tBloomB;
uniform int uMode;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform float uThreshold;
uniform float uKnee;
uniform float uStrength;
varying vec2 vUv;

vec3 bright(vec2 uv) {
	vec3 c = texture2D(tInput, uv).rgb;
	float l = max(max(c.r, c.g), c.b);
	float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
	soft = soft * soft / (4.0 * uKnee + 1e-4);
	float w = max(soft, l - uThreshold) / max(l, 1e-4);
	return c * w;
}

void main() {
	if (uMode == 0) {
		// Threshold while downsampling: a 4-tap box keeps sparkles from flickering.
		vec2 o = uTexel * 0.5;
		vec3 c = bright(vUv + vec2(-o.x, -o.y)) + bright(vUv + vec2(o.x, -o.y))
			+ bright(vUv + vec2(-o.x, o.y)) + bright(vUv + vec2(o.x, o.y));
		gl_FragColor = vec4(c * 0.25, 1.0);
	} else if (uMode == 1) {
		// 9-tap gaussian along uDir using bilinear taps.
		vec3 c = texture2D(tInput, vUv).rgb * 0.227027;
		vec2 d1 = uDir * uTexel * 1.384615;
		vec2 d2 = uDir * uTexel * 3.230769;
		c += texture2D(tInput, vUv + d1).rgb * 0.316216;
		c += texture2D(tInput, vUv - d1).rgb * 0.316216;
		c += texture2D(tInput, vUv + d2).rgb * 0.070270;
		c += texture2D(tInput, vUv - d2).rgb * 0.070270;
		gl_FragColor = vec4(c, 1.0);
	} else if (uMode == 2) {
		gl_FragColor = vec4(texture2D(tInput, vUv).rgb, 1.0);
	} else {
		vec3 base = texture2D(tInput, vUv).rgb;
		vec3 glow = texture2D(tBloomA, vUv).rgb * 0.65 + texture2D(tBloomB, vUv).rgb * 0.9;
		gl_FragColor = vec4(base + glow * uStrength, 1.0);
		#include <tonemapping_fragment>
		#include <colorspace_fragment>
	}
}`;

export function Bloom({
	/** Resolution of the scene target relative to the canvas (cheaper below 1). */
	samples,
	strength,
}: {
	samples: number;
	strength: number;
}) {
	const scene = useThree((state) => state.scene);
	const size = useThree((state) => state.size);
	const dpr = useThree((state) => state.viewport.dpr);
	const width = Math.max(1, Math.round(size.width * dpr));
	const height = Math.max(1, Math.round(size.height * dpr));
	const quarter: [number, number] = [
		Math.max(1, Math.round(width / 4)),
		Math.max(1, Math.round(height / 4)),
	];
	const eighth: [number, number] = [
		Math.max(1, Math.round(width / 8)),
		Math.max(1, Math.round(height / 8)),
	];
	const sceneTarget = useFBO(width, height, { samples, type: HALF_FLOAT });
	const quarterA = useFBO(...quarter, { type: HALF_FLOAT });
	const quarterB = useFBO(...quarter, { type: HALF_FLOAT });
	const eighthA = useFBO(...eighth, { type: HALF_FLOAT });
	const eighthB = useFBO(...eighth, { type: HALF_FLOAT });
	const quad = useRef<Mesh>(null);
	const material = useRef<ShaderMaterial>(null);
	const postScene = useMemo(
		() => new (scene.constructor as new () => Scene)(),
		[scene]
	);
	const uniforms = useMemo(
		() => ({
			tBloomA: { value: null as unknown },
			tBloomB: { value: null as unknown },
			tInput: { value: null as unknown },
			uDir: { value: { x: 1, y: 0 } },
			uKnee: { value: KNEE },
			uMode: { value: 0 },
			uStrength: { value: strength },
			uTexel: { value: { x: 1, y: 1 } },
			uThreshold: { value: THRESHOLD },
		}),
		[strength]
	);

	useBoundUniforms(material, uniforms);

	useFrame(({ camera, gl }) => {
		const shader = material.current;
		if (!(quad.current && shader)) {
			return;
		}

		const pass = (
			mode: number,
			input: unknown,
			target: typeof sceneTarget | null,
			texel: readonly [number, number],
			dir: readonly [number, number] = [0, 0]
		) => {
			uniforms.uMode.value = mode;
			uniforms.tInput.value = input;
			uniforms.uTexel.value.x = 1 / texel[0];
			uniforms.uTexel.value.y = 1 / texel[1];
			uniforms.uDir.value.x = dir[0];
			uniforms.uDir.value.y = dir[1];
			// One material renders every pass back to back; three only
			// re-uploads its uniforms between draws when told to.
			shader.uniformsNeedUpdate = true;
			gl.setRenderTarget(target);
			gl.render(postScene, camera);
		};
		gl.setRenderTarget(sceneTarget);
		gl.render(scene, camera);
		// Only the final pass reads the bloom targets; binding them while a
		// blur writes into one of them would be a feedback loop (and WebGL
		// drops such draws).
		uniforms.tBloomA.value = null;
		uniforms.tBloomB.value = null;
		pass(0, sceneTarget.texture, quarterA, [width, height]);
		pass(1, quarterA.texture, quarterB, quarter, [1, 0]);
		pass(1, quarterB.texture, quarterA, quarter, [0, 1]);
		pass(2, quarterA.texture, eighthA, quarter);
		pass(1, eighthA.texture, eighthB, eighth, [1.6, 0]);
		pass(1, eighthB.texture, eighthA, eighth, [0, 1.6]);
		uniforms.tBloomA.value = quarterA.texture;
		uniforms.tBloomB.value = eighthA.texture;
		pass(3, sceneTarget.texture, null, [width, height]);
	}, 1);

	return createPortal(
		<mesh frustumCulled={false} ref={quad}>
			<planeGeometry args={[2, 2]} />
			<shaderMaterial
				depthTest={false}
				depthWrite={false}
				fragmentShader={QUAD_FRAGMENT}
				ref={material}
				uniforms={uniforms}
				vertexShader={QUAD_VERTEX}
			/>
		</mesh>,
		postScene
	);
}
