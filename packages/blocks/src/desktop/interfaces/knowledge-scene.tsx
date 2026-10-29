/* eslint-disable react/no-unknown-property */
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { type ComponentRef, useEffect, useMemo, useRef } from "react";
import type {
	BufferGeometry,
	Material,
	Mesh,
	PerspectiveCamera,
	Points,
	ShaderMaterial,
} from "three";
import {
	isSettled,
	layoutBounds,
	stepLayout,
	type Vec3,
} from "./knowledge-model.ts";
import { unitRgb } from "./knowledge-palette.ts";
import {
	anchor,
	basisOf,
	type CameraFrame,
	DISC_SCALE,
	dot,
	easeAlpha,
	FOCUS_MARGIN,
	type FreeArea,
	fitCamera,
	focalLength,
	freeArea,
	INITIAL_DIRECTION,
	inFreeArea,
	type KnowledgeRendererProps,
	neighbourIndices,
	RING_REACH_PX,
	SCENE_FOV,
	SCENE_NEAR,
	syncLabels,
} from "./knowledge-stage.ts";

/**
 * The Knowledge graph in WebGL (lazy-loaded): nodes are camera-facing discs
 * (a points shader, so they stay round and crisp at any zoom, like
 * Obsidian's), links are hairlines, and depth reads through perspective size
 * and a soft fog. One frame callback steps the force layout, eases styles,
 * moves the camera, and projects every node for the DOM label layer and for
 * picking. Three is imported for types only; R3F owns the runtime objects.
 */

const FOV = SCENE_FOV;
const NEAR = SCENE_NEAR;
/** The selection ring: a hairline gap, then a 2px band (CSS pixels). */
const RING_GAP_PX = 2;
const RING_OUTER_PX = RING_REACH_PX;
const FLIGHT_SECONDS = 1.2;
/**
 * World radius of a disc relative to its layout radius: the layout spaces
 * nodes for their full radius, and the discs sit small inside that room,
 * like Obsidian's.
 */
const SCENE_NODE_SCALE = DISC_SCALE.scene;
/** Where an agent's inner cut sits, as a share of its radius. */
const AGENT_CUT = 0.62;
/**
 * How far toward the background the back of the graph fades: discs keep
 * their colour at the front and lose about a third of it at the back, so
 * depth reads at rest, without dragging.
 */
const NODE_FOG = 0.36;
const LINK_FOG = 0.5;
const FOG_ALPHA = 0.45;
const NORMAL_BLENDING = 1;
/** Camera moves smaller than this (world units) count as settled. */
const CAMERA_EPSILON = 0.02;

type Controls = ComponentRef<typeof OrbitControls>;

const NODE_VERTEX = /* glsl */ `
attribute vec3 aColor;
attribute float aAlpha;
attribute float aSize;
attribute float aRing;
uniform float uScale;
uniform float uPixel;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogMin;
uniform vec3 uBackground;
varying vec3 vColor;
varying float vAlpha;
varying float vRing;
varying float vAgent;
varying float vBody;
varying float vHalf;
void main() {
	vec4 mv = modelViewMatrix * vec4(position, 1.0);
	float depth = max(-mv.z, 0.001);
	vBody = max(aSize * uScale / depth, 1.0);
	vHalf = vBody + ${RING_OUTER_PX.toFixed(1)} * uPixel + 1.0;
	gl_PointSize = vHalf * 2.0;
	float fog = smoothstep(uFogNear, uFogFar, depth);
	vColor = mix(aColor, uBackground, fog * ${NODE_FOG.toFixed(2)});
	// aRing carries the agent flag as +2 (see the styles copy below).
	vAgent = step(1.5, aRing);
	vRing = aRing - vAgent * 2.0;
	vAlpha = aAlpha * mix(1.0, uFogMin, fog);
	gl_Position = projectionMatrix * mv;
}
`;

const NODE_FRAGMENT = /* glsl */ `
uniform vec3 uRing;
uniform vec3 uBackground;
uniform float uPixel;
varying vec3 vColor;
varying float vAlpha;
varying float vRing;
varying float vAgent;
varying float vBody;
varying float vHalf;
void main() {
	float r = length(gl_PointCoord * 2.0 - 1.0) * vHalf;
	float aa = 0.75 * uPixel;
	float body = 1.0 - smoothstep(vBody - aa, vBody + aa, r);
	float inner = vBody + ${RING_GAP_PX.toFixed(1)} * uPixel;
	float outer = vBody + ${RING_OUTER_PX.toFixed(1)} * uPixel;
	float ring = step(0.01, vRing) * smoothstep(inner - aa, inner + aa, r) * (1.0 - smoothstep(outer - aa, outer + aa, r));
	float alpha = max(body, ring);
	if (alpha < 0.01) discard;
	// Agents: a hairline cut inside the disc, so the shape says "agent".
	float cutIn = vBody * ${AGENT_CUT.toFixed(2)};
	float cutWidth = max(1.25 * uPixel, vBody * 0.1);
	float cut = vAgent * step(4.0 * uPixel, vBody) * smoothstep(cutIn - aa, cutIn + aa, r) * (1.0 - smoothstep(cutIn + cutWidth - aa, cutIn + cutWidth + aa, r));
	vec3 color = mix(mix(vColor, uBackground, cut * body), uRing, ring * (1.0 - body));
	float ringAlpha = mix(1.0, vRing, ring * (1.0 - body));
	gl_FragColor = vec4(color, alpha * vAlpha * ringAlpha);
}
`;

/**
 * Links are screen-space quads (GL lines are always one pixel wide): each
 * end is pushed out along the link's normal by half the link width, with a
 * pixel of anti-aliasing on either edge.
 */
const LINK_VERTEX = /* glsl */ `
attribute vec3 aOther;
attribute vec2 aShape;
attribute vec3 aColor;
attribute float aAlpha;
uniform vec2 uViewport;
uniform float uWidth;
uniform float uPixel;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogMin;
uniform vec3 uBackground;
varying vec3 vColor;
varying float vAlpha;
varying float vEdge;
void main() {
	vec4 mv = modelViewMatrix * vec4(position, 1.0);
	vec4 clip = projectionMatrix * mv;
	vec4 other = projectionMatrix * modelViewMatrix * vec4(aOther, 1.0);
	vec2 half_viewport = uViewport * 0.5;
	vec2 here = clip.xy / clip.w * half_viewport;
	vec2 there = other.xy / other.w * half_viewport;
	vec2 dir = aShape.x > 0.5 ? here - there : there - here;
	float len = length(dir);
	dir = len > 0.0001 ? dir / len : vec2(1.0, 0.0);
	vec2 normal = vec2(-dir.y, dir.x);
	float reach = uWidth * 0.5 + uPixel;
	clip.xy += normal * aShape.y * reach / half_viewport * clip.w;
	vEdge = aShape.y * reach;
	float depth = max(-mv.z, 0.001);
	float fog = smoothstep(uFogNear, uFogFar, depth);
	vColor = mix(aColor, uBackground, fog * ${LINK_FOG.toFixed(2)});
	vAlpha = aAlpha * mix(1.0, uFogMin, fog) * min(1.0, uWidth / uPixel);
	gl_Position = clip;
}
`;

const LINK_FRAGMENT = /* glsl */ `
uniform float uWidth;
uniform float uPixel;
varying vec3 vColor;
varying float vAlpha;
varying float vEdge;
void main() {
	float halfWidth = max(uWidth, uPixel) * 0.5;
	float cover = clamp((halfWidth - abs(vEdge)) / uPixel + 0.5, 0.0, 1.0);
	if (cover <= 0.0) discard;
	gl_FragColor = vec4(vColor, vAlpha * cover);
}
`;

export default function KnowledgeScene(props: KnowledgeRendererProps) {
	const latest = useRef(props);
	latest.current = props;
	return (
		<Canvas
			camera={{ far: 40_000, fov: FOV, near: NEAR, position: [0, 0, 400] }}
			dpr={props.quality === "high" ? [1, 2] : [1, 1]}
			flat
			// Frames are drawn on demand: while the layout settles, the camera
			// moves or styles ease. A settled graph leaves the GPU idle.
			frameloop={props.paused ? "never" : "demand"}
			// Discs and links anti-alias in their own shaders, so no MSAA.
			gl={{
				alpha: true,
				antialias: false,
				powerPreference: "high-performance",
			}}
			onCreated={({ gl }) => {
				// A lost context (GPU reset, too many contexts) hands over to
				// the 2D renderer instead of leaving a blank stage.
				gl.domElement.addEventListener(
					"webglcontextlost",
					(event) => {
						event.preventDefault();
						latest.current.onLost?.();
					},
					{ once: true }
				);
			}}
			style={{ inset: 0, position: "absolute" }}
		>
			{props.layout.ids.length > 0 ? (
				<Graph key={props.layout.ids.join("|")} {...props} />
			) : null}
		</Canvas>
	);
}

interface CameraState {
	autoFit: boolean;
	first: boolean;
	flight: {
		/** Node flights: whether the already-in-view check has run. */
		checked?: boolean;
		distance: number | null;
		id: string | null;
		point: Vec3 | null;
		started: number;
	} | null;
	/**
	 * The pose when a pointer or wheel gesture began (null when none is
	 * running). Framing pauses during a gesture; only one that actually moved
	 * the camera ends the auto-fit, so a plain click keeps it.
	 */
	gesture: { distance: number; direction: Vec3; target: Vec3 } | null;
	/** The settings card inset the framing was last computed for. */
	inset: number;
	/** A node to ease to once the first fit has been drawn. */
	pending: string | null;
	/** Whether the first frame has been reported to the host. */
	ready: boolean;
}

function Graph(props: KnowledgeRendererProps) {
	const { layout, palette } = props;
	const latest = useRef(props);
	latest.current = props;
	const controls = useRef<Controls>(null);
	const points = useRef<Points>(null);
	const lines = useRef<Mesh>(null);
	const camera = useRef<CameraState>({
		autoFit: true,
		first: true,
		flight: null,
		gesture: null,
		inset: props.insetRight,
		pending: props.focusId,
		ready: false,
	});
	const clock = useRef(0);
	const size = useRef({ height: 1, width: 1 });
	const invalidate = useThree((state) => state.invalidate);
	// Any new props (styles, settings, the stage inset) need a frame.
	useEffect(() => {
		invalidate();
	});

	const count = layout.ids.length;
	const linkCount = layout.links.length / 2;
	const buffers = useMemo(
		() => ({
			linkAlpha: new Float32Array(linkCount * 4),
			linkAlphaNow: new Float32Array(linkCount),
			linkColor: new Float32Array(linkCount * 12),
			linkIndex: linkQuadIndex(linkCount),
			linkOther: new Float32Array(linkCount * 12),
			linkPosition: new Float32Array(linkCount * 12),
			linkShape: linkQuadShape(linkCount),
			nodeAlpha: new Float32Array(count),
			nodeAlphaNow: new Float32Array(count),
			nodeColor: new Float32Array(count * 3),
			nodePosition: new Float32Array(count * 3),
			nodeRing: new Float32Array(count),
			nodeSize: new Float32Array(count),
			order: new Uint32Array(count).map((_, index) => index),
			styles: null as KnowledgeRendererProps["styles"] | null,
		}),
		[count, linkCount]
	);

	const nodeUniforms = useMemo(
		() => ({
			uBackground: { value: unitRgb(palette.background) },
			uFogFar: { value: 400 },
			// Discs stay opaque (links never show through them); depth reads
			// through colour, size and the links' own fade.
			uFogMin: { value: 1 },
			uFogNear: { value: 100 },
			uPixel: { value: 1 },
			uRing: { value: unitRgb(palette.highlight) },
			uScale: { value: 400 },
		}),
		[palette]
	);
	const linkUniforms = useMemo(
		() => ({
			uBackground: { value: unitRgb(palette.background) },
			uFogFar: { value: 400 },
			uFogMin: { value: 1 - FOG_ALPHA },
			uFogNear: { value: 100 },
			uPixel: { value: 1 },
			uViewport: { value: [1, 1] },
			uWidth: { value: 1 },
		}),
		[palette]
	);

	useEffect(() => {
		const focus = (id: string) => {
			camera.current.pending = null;
			// While the whole graph is framed, every node is already in view
			// (and the frame follows the stage as panels open and close).
			if (camera.current.autoFit) {
				return;
			}
			camera.current.flight = {
				distance: null,
				id,
				point: null,
				started: clock.current,
			};
			invalidate();
		};
		props.cameraApi.current = {
			focus,
			invalidate,
			reveal: (id) => {
				const index = layout.index.get(id);
				const { projection } = latest.current;
				const area = freeArea(
					size.current.width,
					size.current.height,
					latest.current.insetRight
				);
				if (index === undefined || !inFreeArea(projection, index, area)) {
					focus(id);
				}
			},
			reset: () => {
				camera.current.autoFit = true;
				camera.current.flight = null;
				invalidate();
			},
			zoom: (factor) => {
				const lens = controls.current;
				if (!lens) {
					return;
				}
				const { object, target } = lens;
				const distance = object.position.distanceTo(target);
				camera.current.autoFit = false;
				camera.current.flight = {
					distance: distance * factor,
					id: null,
					point: null,
					started: clock.current,
				};
				invalidate();
			},
		};
		return () => {
			props.cameraApi.current = null;
		};
	}, [props.cameraApi, layout, invalidate]);

	useFrame((state, frameDelta) => {
		const current = latest.current;
		const lens = state.camera as PerspectiveCamera;
		const orbit = controls.current;
		if (!orbit) {
			return;
		}
		// On demand, the gap since the last frame can be long: cap it.
		const delta = Math.min(frameDelta, 0.1);
		clock.current += delta;
		const view = camera.current;
		// The first frame draws the layout exactly as the loading outline
		// showed it (same pose, no tick in between).
		if (!(current.reduced || view.first)) {
			stepLayout(layout, current.forces);
		}

		// Camera: auto-fit while the layout settles, or fly to a node.
		const bounds = layoutBounds(layout);
		const { height, width } = state.size;
		size.current = { height, width };
		const halfTan = Math.tan((lens.fov * Math.PI) / 360);
		const frame: CameraFrame = {
			area: freeArea(width, height, current.insetRight),
			focal: focalLength(height, lens.fov),
			height,
			width,
		};
		const target = orbit.target;
		const dx = lens.position.x - target.x;
		const dy = lens.position.y - target.y;
		const dz = lens.position.z - target.z;
		let distance = Math.hypot(dx, dy, dz) || 1;
		// The first frame opens on the same pose as the loading outline
		// (openingPose): this direction, fitted the same way.
		const direction: Vec3 = view.first
			? INITIAL_DIRECTION
			: [dx / distance, dy / distance, dz / distance];
		const basis = basisOf(direction);
		if (view.inset !== current.insetRight) {
			// The settings card opened or closed: keep what sat in the middle
			// of the old free area in the middle of the new one.
			const before = freeArea(width, height, view.inset);
			view.inset = current.insetRight;
			if (!(view.autoFit || view.gesture || view.flight)) {
				const sx =
					(((before.left + before.right) / 2 - width / 2) * distance) /
					frame.focal;
				const sy =
					(((before.top + before.bottom) / 2 - height / 2) * distance) /
					frame.focal;
				view.flight = {
					distance: null,
					id: null,
					point: [
						target.x + basis.right[0] * sx - basis.up[0] * sy,
						target.y + basis.right[1] * sx - basis.up[1] * sy,
						target.z + basis.right[2] * sx - basis.up[2] * sy,
					],
					started: clock.current,
				};
			}
		}
		const fit = fitCamera(
			layout,
			basis,
			frame,
			current.labels,
			current.forces.linkDistance * 1.6
		);
		if (!view.first && view.pending) {
			const id = view.pending;
			view.pending = null;
			if (!view.autoFit) {
				view.flight = {
					distance: null,
					id,
					point: null,
					started: clock.current,
				};
			}
		}
		let goalTarget: Vec3 | null = null;
		let goalDistance: number | null = null;
		if (view.gesture) {
			// The user is steering: no framing until the gesture ends.
		} else if (view.autoFit) {
			goalDistance = fit.distance;
			goalTarget = anchor(fit.center, basis, frame, fit.distance);
		}
		const flightIndex = view.flight?.id
			? layout.index.get(view.flight.id)
			: undefined;
		const group =
			flightIndex === undefined ? null : neighbourIndices(layout, flightIndex);
		if (view.flight && group && !view.flight.checked) {
			view.flight.checked = true;
			// Already in view with its neighbours: keep the framing (the
			// emphasis shows the selection); a flight would only crop.
			if (allInView(current.projection, group, frame.area)) {
				view.flight = null;
			}
		}
		if (view.flight && group) {
			// Bring the node and its neighbours into the free area, clear of
			// the settings card and the panel. Never zooms in; zooms out only
			// as far as the neighbourhood needs, and never past the fit.
			const near = fitCamera(
				layout,
				basis,
				frame,
				current.labels,
				current.forces.linkDistance * 0.8,
				group
			);
			goalDistance = Math.min(
				fit.distance,
				Math.max(near.distance * FOCUS_MARGIN, distance)
			);
			goalTarget = anchor(near.center, basis, frame, goalDistance);
		} else if (view.flight) {
			const point = view.flight.point;
			goalDistance = view.flight.distance ?? goalDistance;
			if (point) {
				goalTarget = anchor(point, basis, frame, goalDistance ?? distance);
			}
		}
		if (view.flight && clock.current - view.flight.started > FLIGHT_SECONDS) {
			view.flight = null;
		}
		const ease = current.reduced || view.first ? 1 : 1 - Math.exp(-delta * 4.5);
		const cameraMoving =
			(goalTarget !== null &&
				Math.hypot(
					goalTarget[0] - target.x,
					goalTarget[1] - target.y,
					goalTarget[2] - target.z
				) > CAMERA_EPSILON) ||
			(goalDistance !== null &&
				Math.abs(goalDistance - distance) > CAMERA_EPSILON);
		if (goalTarget) {
			target.x += (goalTarget[0] - target.x) * ease;
			target.y += (goalTarget[1] - target.y) * ease;
			target.z += (goalTarget[2] - target.z) * ease;
		}
		if (goalDistance !== null) {
			distance += (goalDistance - distance) * ease;
		}
		lens.position.set(
			target.x + direction[0] * distance,
			target.y + direction[1] * distance,
			target.z + direction[2] * distance
		);
		lens.lookAt(target);
		view.first = false;
		orbit.maxDistance = Math.max(600, bounds.radius * 8);

		// Styles: copy colours when React hands over new styles, ease opacity.
		const styles = current.styles;
		if (buffers.styles !== styles) {
			buffers.styles = styles;
			buffers.nodeColor.set(styles.colors);
			for (let node = 0; node < count; node += 1) {
				buffers.nodeSize[node] = (styles.size[node] ?? 2) * SCENE_NODE_SCALE;
			}
			for (let node = 0; node < count; node += 1) {
				buffers.nodeRing[node] =
					(styles.ring[node] ?? 0) + (styles.agent[node] ?? 0) * 2;
			}
			for (let link = 0; link < linkCount; link += 1) {
				const color = styles.linkColors.subarray(link * 3, link * 3 + 3);
				for (let corner = 0; corner < 4; corner += 1) {
					buffers.linkColor.set(color, link * 12 + corner * 3);
				}
			}
		}
		const amount = current.reduced ? 1 : 1 - Math.exp(-delta * 12);
		const nodesEasing = easeAlpha(buffers.nodeAlphaNow, styles.alpha, amount);
		const linksEasing = easeAlpha(
			buffers.linkAlphaNow,
			styles.linkAlpha,
			amount
		);
		buffers.nodeAlpha.set(buffers.nodeAlphaNow);
		for (let link = 0; link < linkCount; link += 1) {
			buffers.linkAlpha.fill(
				buffers.linkAlphaNow[link] ?? 0,
				link * 4,
				link * 4 + 4
			);
		}

		// Positions.
		buffers.nodePosition.set(layout.positions);
		for (let link = 0; link < linkCount; link += 1) {
			const source = layout.positions.subarray(
				(layout.links[link * 2] ?? 0) * 3,
				(layout.links[link * 2] ?? 0) * 3 + 3
			);
			const goal = layout.positions.subarray(
				(layout.links[link * 2 + 1] ?? 0) * 3,
				(layout.links[link * 2 + 1] ?? 0) * 3 + 3
			);
			// Corners 0 and 1 sit at the source, 2 and 3 at the target.
			const offset = link * 12;
			buffers.linkPosition.set(source, offset);
			buffers.linkPosition.set(source, offset + 3);
			buffers.linkPosition.set(goal, offset + 6);
			buffers.linkPosition.set(goal, offset + 9);
			buffers.linkOther.set(goal, offset);
			buffers.linkOther.set(goal, offset + 3);
			buffers.linkOther.set(source, offset + 6);
			buffers.linkOther.set(source, offset + 9);
		}

		// Projection (labels, picking, back-to-front order) and fog.
		lens.updateMatrixWorld();
		const v = lens.matrixWorldInverse.elements;
		const m = lens.projectionMatrix.elements;
		const projection = current.projection;
		// Fog spans the graph's depth: the front keeps full colour, the back
		// fades toward the background.
		const fogNear = Math.max(NEAR, distance - bounds.radius * 0.6);
		const fogFar = distance + bounds.radius * 0.8;
		for (let index = 0; index < count; index += 1) {
			const x = layout.positions[index * 3] ?? 0;
			const y = layout.positions[index * 3 + 1] ?? 0;
			const z = layout.positions[index * 3 + 2] ?? 0;
			const vx =
				(v[0] ?? 0) * x + (v[4] ?? 0) * y + (v[8] ?? 0) * z + (v[12] ?? 0);
			const vy =
				(v[1] ?? 0) * x + (v[5] ?? 0) * y + (v[9] ?? 0) * z + (v[13] ?? 0);
			const vz =
				(v[2] ?? 0) * x + (v[6] ?? 0) * y + (v[10] ?? 0) * z + (v[14] ?? 0);
			const depth = -vz;
			const sx = ((((m[0] ?? 1) * vx) / depth) * 0.5 + 0.5) * width;
			const sy = (-(((m[5] ?? 1) * vy) / depth) * 0.5 + 0.5) * height;
			const radius =
				((buffers.nodeSize[index] ?? 1) / Math.max(depth * halfTan, 1e-3)) *
				(height / 2);
			projection.x[index] = sx;
			projection.y[index] = sy;
			projection.depth[index] = depth;
			projection.fog[index] = smoothstep(fogNear, fogFar, depth);
			projection.radius[index] = radius;
			projection.visible[index] =
				depth > NEAR &&
				sx > -60 &&
				sy > -60 &&
				sx < width + 60 &&
				sy < height + 60
					? 1
					: 0;
		}
		buffers.order.sort(
			(a, b) => (projection.depth[b] ?? 0) - (projection.depth[a] ?? 0)
		);
		// Write through the live materials: the renderer may hold its own
		// copy of the uniforms objects handed to it as props.
		const background = unitRgb(current.palette.background);
		setUniforms(points.current?.material, {
			uBackground: background,
			uFogFar: fogFar,
			uFogNear: fogNear,
			uPixel: state.viewport.dpr,
			uRing: unitRgb(current.palette.highlight),
			uScale: (height * state.viewport.dpr) / (2 * halfTan),
		});
		setUniforms(lines.current?.material, {
			uBackground: background,
			uFogFar: fogFar,
			uFogNear: fogNear,
			uPixel: state.viewport.dpr,
			uViewport: [width * state.viewport.dpr, height * state.viewport.dpr],
			uWidth: current.linkWidth * state.viewport.dpr,
		});

		markDirty(points.current?.geometry, [
			"position",
			"aColor",
			"aAlpha",
			"aSize",
			"aRing",
		]);
		const index = points.current?.geometry.index;
		if (index) {
			index.needsUpdate = true;
		}
		markDirty(lines.current?.geometry, [
			"position",
			"aOther",
			"aColor",
			"aAlpha",
		]);
		syncLabels(
			layout,
			projection,
			styles,
			buffers.nodeAlphaNow,
			current.labels,
			{
				height,
				obstacles: current.obstacles(),
				textFade: current.textFade,
				width,
			}
		);
		if (!view.ready) {
			view.ready = true;
			current.onReady?.();
		}
		// Keep drawing only while something still moves; OrbitControls asks
		// for frames itself while the user steers (and while it damps).
		const layoutMoving = !(current.reduced || isSettled(layout));
		if (
			layoutMoving ||
			cameraMoving ||
			view.flight !== null ||
			view.pending !== null ||
			nodesEasing ||
			linksEasing
		) {
			state.invalidate();
		}
	});

	return (
		<>
			<mesh frustumCulled={false} ref={lines} renderOrder={0}>
				<bufferGeometry>
					<bufferAttribute args={[buffers.linkIndex, 1]} attach="index" />
					<bufferAttribute
						args={[buffers.linkPosition, 3]}
						attach="attributes-position"
					/>
					<bufferAttribute
						args={[buffers.linkOther, 3]}
						attach="attributes-aOther"
					/>
					<bufferAttribute
						args={[buffers.linkShape, 2]}
						attach="attributes-aShape"
					/>
					<bufferAttribute
						args={[buffers.linkColor, 3]}
						attach="attributes-aColor"
					/>
					<bufferAttribute
						args={[buffers.linkAlpha, 1]}
						attach="attributes-aAlpha"
					/>
				</bufferGeometry>
				<shaderMaterial
					blending={NORMAL_BLENDING}
					depthTest={false}
					depthWrite={false}
					fragmentShader={LINK_FRAGMENT}
					transparent
					uniforms={linkUniforms}
					vertexShader={LINK_VERTEX}
				/>
			</mesh>
			<points frustumCulled={false} ref={points} renderOrder={1}>
				<bufferGeometry>
					<bufferAttribute args={[buffers.order, 1]} attach="index" />
					<bufferAttribute
						args={[buffers.nodePosition, 3]}
						attach="attributes-position"
					/>
					<bufferAttribute
						args={[buffers.nodeColor, 3]}
						attach="attributes-aColor"
					/>
					<bufferAttribute
						args={[buffers.nodeAlpha, 1]}
						attach="attributes-aAlpha"
					/>
					<bufferAttribute
						args={[buffers.nodeSize, 1]}
						attach="attributes-aSize"
					/>
					<bufferAttribute
						args={[buffers.nodeRing, 1]}
						attach="attributes-aRing"
					/>
				</bufferGeometry>
				<shaderMaterial
					blending={NORMAL_BLENDING}
					depthTest={false}
					depthWrite={false}
					fragmentShader={NODE_FRAGMENT}
					transparent
					uniforms={nodeUniforms}
					vertexShader={NODE_VERTEX}
				/>
			</points>
			<OrbitControls
				dampingFactor={0.09}
				enableDamping={!props.reduced}
				makeDefault
				maxDistance={4000}
				minDistance={8}
				onEnd={() => {
					const view = camera.current;
					const start = view.gesture;
					view.gesture = null;
					const lens = controls.current;
					if (!(start && lens)) {
						return;
					}
					const pose = poseOf(lens);
					const moved =
						Math.abs(pose.distance - start.distance) > start.distance * 0.01 ||
						dot(pose.direction, start.direction) < 0.9999 ||
						Math.hypot(
							pose.target[0] - start.target[0],
							pose.target[1] - start.target[1],
							pose.target[2] - start.target[2]
						) >
							start.distance * 0.002;
					if (moved) {
						view.autoFit = false;
					}
				}}
				onStart={() => {
					const lens = controls.current;
					camera.current.flight = null;
					camera.current.gesture = lens ? poseOf(lens) : null;
				}}
				ref={controls}
				rotateSpeed={0.6}
				screenSpacePanning
				zoomSpeed={2.4}
				zoomToCursor
			/>
		</>
	);
}

/** Two triangles per link quad: corners 0, 1 at the source, 2, 3 at the target. */
function linkQuadIndex(linkCount: number): Uint32Array {
	const index = new Uint32Array(linkCount * 6);
	for (let link = 0; link < linkCount; link += 1) {
		const base = link * 4;
		index.set(
			[base, base + 1, base + 2, base + 2, base + 1, base + 3],
			link * 6
		);
	}
	return index;
}

/** Per corner: which end it sits at (0 source, 1 target) and its side (±1). */
function linkQuadShape(linkCount: number): Float32Array {
	const shape = new Float32Array(linkCount * 8);
	for (let link = 0; link < linkCount; link += 1) {
		shape.set([0, 1, 0, -1, 1, 1, 1, -1], link * 8);
	}
	return shape;
}

/** The camera's distance, view direction and target right now. */
function poseOf(lens: Controls): {
	direction: Vec3;
	distance: number;
	target: Vec3;
} {
	const { object, target } = lens;
	const offset: Vec3 = [
		object.position.x - target.x,
		object.position.y - target.y,
		object.position.z - target.z,
	];
	const distance = Math.hypot(...offset) || 1;
	return {
		direction: [
			offset[0] / distance,
			offset[1] / distance,
			offset[2] / distance,
		],
		distance,
		target: [target.x, target.y, target.z],
	};
}

/** True when every listed node sits inside the free area. */
function allInView(
	projection: KnowledgeRendererProps["projection"],
	indices: ReadonlySet<number>,
	area: FreeArea
): boolean {
	for (const index of indices) {
		if (!inFreeArea(projection, index, area)) {
			return false;
		}
	}
	return true;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
	const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0 || 1)));
	return t * t * (3 - 2 * t);
}

type UniformValue = number | [number, number] | [number, number, number];

function setUniforms(
	material: Material | Material[] | undefined,
	values: Record<string, UniformValue>
): void {
	if (!material || Array.isArray(material) || !("uniforms" in material)) {
		return;
	}
	const uniforms = (material as ShaderMaterial).uniforms;
	for (const [name, value] of Object.entries(values)) {
		const uniform = uniforms[name];
		if (uniform) {
			uniform.value = value;
		}
	}
}

function markDirty(
	geometry: BufferGeometry | undefined,
	names: readonly string[]
): void {
	if (!geometry) {
		return;
	}
	for (const name of names) {
		const attribute = geometry.getAttribute(name);
		if (attribute) {
			attribute.needsUpdate = true;
		}
	}
}
