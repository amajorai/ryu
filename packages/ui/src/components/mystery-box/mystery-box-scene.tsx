"use client";

// packages/ui/src/components/mystery-box/mystery-box-scene.tsx
//
// A 3D gift box that drops in, idles, rattles when it is opened, and bursts —
// lid flying off, a beam of light, and a spray of confetti in the prize's color.
// It knows nothing about what is inside: the caller owns the prize and reveals
// it in the DOM above the canvas when `onBurst` fires.
//
// Every animation is driven from one `useFrame` timeline rather than React state,
// so a box opening costs no re-renders. `round` restarts the timeline (a fresh
// box drops in) without tearing the canvas down — creating a WebGL context per
// box would stutter exactly at the moment the animation should feel snappiest.
//
// Default export so callers can `lazy()` it: three.js stays out of every bundle
// that never opens a box.

import {
	ContactShadows,
	Environment,
	Lightformer,
	RoundedBox,
} from "@react-three/drei";
import {
	Canvas,
	type ThreeEvent,
	useFrame,
	useThree,
} from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

export interface MysteryBoxSceneProps {
	/** Ribbon, glow, beam, and confetti color — the prize's tier. */
	accent?: string;
	/** Body color of the box. */
	boxColor?: string;
	className?: string;
	/** Clicking the box. Ignored by the scene once it is opening. */
	onActivate?: () => void;
	/** Fires once per round, the instant the lid pops. */
	onBurst?: () => void;
	/** Flip to true to rattle and burst the box. */
	opening: boolean;
	/** Skip the drop, the idle drift, the rattle and the confetti. */
	reducedMotion?: boolean;
	/** Change to drop a fresh, closed box in. */
	round: number;
}

const DROP_SECONDS = 0.85;
const SHAKE_SECONDS = 1.15;
const REDUCED_SHAKE_SECONDS = 0.15;
const CONFETTI_COUNT = 90;
const CONFETTI_LIFE_SECONDS = 2.2;
const GRAVITY = 11;
const BODY_HALF = 0.8;
const BODY_HEIGHT = 1.3;
const LID_REST_Y = BODY_HEIGHT / 2;
const CONFETTI_PALETTE = ["#ffffff", "#fde68a"];

function easeOutBounce(x: number): number {
	const n1 = 7.5625;
	const d1 = 2.75;
	if (x < 1 / d1) {
		return n1 * x * x;
	}
	if (x < 2 / d1) {
		const t = x - 1.5 / d1;
		return n1 * t * t + 0.75;
	}
	if (x < 2.5 / d1) {
		const t = x - 2.25 / d1;
		return n1 * t * t + 0.9375;
	}
	const t = x - 2.625 / d1;
	return n1 * t * t + 0.984_375;
}

/** A transparent "?" decal, tinted with a soft accent glow. */
function useQuestionMarkTexture(accent: string): THREE.CanvasTexture | null {
	const texture = useMemo(() => {
		if (typeof document === "undefined") {
			return null;
		}
		const size = 256;
		const canvas = document.createElement("canvas");
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return null;
		}
		ctx.clearRect(0, 0, size, size);
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.font = "800 190px ui-rounded, system-ui, -apple-system, sans-serif";
		ctx.shadowColor = accent;
		ctx.shadowBlur = 28;
		ctx.fillStyle = "#ffffff";
		ctx.fillText("?", size / 2, size / 2 + 8);
		const tex = new THREE.CanvasTexture(canvas);
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.anisotropy = 4;
		return tex;
	}, [accent]);
	useEffect(() => () => texture?.dispose(), [texture]);
	return texture;
}

function CameraAim() {
	const camera = useThree((state) => state.camera);
	useEffect(() => {
		camera.lookAt(0, 0.35, 0);
	}, [camera]);
	return null;
}

interface Particle {
	life: number;
	position: THREE.Vector3;
	rotation: THREE.Euler;
	scale: number;
	spin: THREE.Vector3;
	velocity: THREE.Vector3;
}

function makeParticles(): Particle[] {
	return Array.from({ length: CONFETTI_COUNT }, () => ({
		life: Number.POSITIVE_INFINITY,
		position: new THREE.Vector3(),
		rotation: new THREE.Euler(),
		scale: 0,
		spin: new THREE.Vector3(),
		velocity: new THREE.Vector3(),
	}));
}

function launchParticles(particles: Particle[]) {
	for (const particle of particles) {
		const angle = Math.random() * Math.PI * 2;
		const tilt = 0.25 + Math.random() * 0.75; // 0 = sideways, 1 = straight up
		const speed = 3.5 + Math.random() * 4.5;
		particle.position.set(
			(Math.random() - 0.5) * 0.9,
			LID_REST_Y,
			(Math.random() - 0.5) * 0.9
		);
		particle.velocity.set(
			Math.cos(angle) * (1 - tilt) * speed,
			tilt * speed + 1.5,
			Math.sin(angle) * (1 - tilt) * speed
		);
		particle.spin.set(
			(Math.random() - 0.5) * 18,
			(Math.random() - 0.5) * 18,
			(Math.random() - 0.5) * 18
		);
		particle.rotation.set(0, 0, 0);
		particle.scale = 0.05 + Math.random() * 0.07;
		particle.life = 0;
	}
}

interface Timeline {
	burstFired: boolean;
	/** Clock time the current drop started; null → stamp on the next frame. */
	dropStart: number | null;
	lidPosition: THREE.Vector3;
	lidSpin: THREE.Vector3;
	lidVelocity: THREE.Vector3;
	/** Clock time the box started opening; null while closed. */
	openStart: number | null;
	pendingOpen: boolean;
}

function freshTimeline(): Timeline {
	return {
		burstFired: false,
		dropStart: null,
		lidPosition: new THREE.Vector3(0, LID_REST_Y, 0),
		lidSpin: new THREE.Vector3(),
		lidVelocity: new THREE.Vector3(),
		openStart: null,
		pendingOpen: false,
	};
}

function GiftBox({
	accent,
	boxColor,
	onActivate,
	onBurst,
	opening,
	reducedMotion,
	round,
}: Required<
	Pick<MysteryBoxSceneProps, "accent" | "boxColor" | "opening" | "round">
> &
	Pick<MysteryBoxSceneProps, "onActivate" | "onBurst" | "reducedMotion">) {
	const root = useRef<THREE.Group>(null);
	const body = useRef<THREE.Group>(null);
	const lid = useRef<THREE.Group>(null);
	const beam = useRef<THREE.Group>(null);
	const beamMaterial = useRef<THREE.MeshBasicMaterial>(null);
	const glow = useRef<THREE.MeshBasicMaterial>(null);
	const light = useRef<THREE.PointLight>(null);
	const confetti = useRef<THREE.InstancedMesh>(null);
	const timeline = useRef<Timeline>(freshTimeline());
	const particles = useMemo(makeParticles, []);
	const dummy = useMemo(() => new THREE.Object3D(), []);
	const [hovered, setHovered] = useState(false);
	const gl = useThree((state) => state.gl);
	const questionMark = useQuestionMarkTexture(accent);
	// The latest callbacks, read from the frame loop without re-subscribing it.
	const onBurstRef = useRef(onBurst);
	onBurstRef.current = onBurst;

	// A new round: a fresh closed box, dropped from above.
	useEffect(() => {
		timeline.current = freshTimeline();
		for (const particle of particles) {
			particle.life = Number.POSITIVE_INFINITY;
		}
	}, [round, particles]);

	useEffect(() => {
		if (opening && timeline.current.openStart === null) {
			timeline.current.pendingOpen = true;
		}
	}, [opening]);

	// Confetti colors: the prize's accent, salted with white and gold.
	useEffect(() => {
		const mesh = confetti.current;
		if (!mesh) {
			return;
		}
		const color = new THREE.Color();
		for (let i = 0; i < CONFETTI_COUNT; i++) {
			color.set(i % 3 === 0 ? accent : (CONFETTI_PALETTE[i % 2] ?? accent));
			mesh.setColorAt(i, color);
		}
		if (mesh.instanceColor) {
			mesh.instanceColor.needsUpdate = true;
		}
	}, [accent]);

	useEffect(() => {
		gl.domElement.style.cursor = hovered && !opening ? "pointer" : "";
	}, [gl, hovered, opening]);

	useFrame((state, rawDelta) => {
		const delta = Math.min(rawDelta, 1 / 20);
		const now = state.clock.elapsedTime;
		const tl = timeline.current;
		const rootGroup = root.current;
		const bodyGroup = body.current;
		const lidGroup = lid.current;
		if (!(rootGroup && bodyGroup && lidGroup)) {
			return;
		}
		if (tl.dropStart === null) {
			tl.dropStart = now;
		}
		if (tl.pendingOpen) {
			tl.pendingOpen = false;
			tl.openStart = now;
		}

		// ── Drop in ──────────────────────────────────────────────────────────
		const dropT = reducedMotion
			? 1
			: Math.min(1, (now - tl.dropStart) / DROP_SECONDS);
		rootGroup.position.y = 3.2 * (1 - easeOutBounce(dropT));

		const shakeSeconds = reducedMotion ? REDUCED_SHAKE_SECONDS : SHAKE_SECONDS;
		const openT = tl.openStart === null ? -1 : now - tl.openStart;
		const shaking = openT >= 0 && openT < shakeSeconds;
		const burst = openT >= shakeSeconds;

		// ── Idle drift / hover ───────────────────────────────────────────────
		const hoverScale = hovered && openT < 0 ? 1.06 : 1;
		if (reducedMotion) {
			rootGroup.rotation.y = 0.6;
		} else {
			const k = shaking ? openT / shakeSeconds : 0;
			const spinSpeed = burst ? 0.25 : 0.45 + 7 * k * k;
			rootGroup.rotation.y += delta * spinSpeed;
		}

		if (shaking && !reducedMotion) {
			const k = openT / shakeSeconds;
			const amp = 0.035 + 0.16 * k * k;
			bodyGroup.rotation.z = Math.sin(now * 46) * amp;
			bodyGroup.rotation.x = Math.cos(now * 37) * amp * 0.6;
			bodyGroup.position.y = Math.abs(Math.sin(now * 23)) * 0.1 * k;
			bodyGroup.scale.set(1 + 0.04 * k, 1 - 0.08 * k, 1 + 0.04 * k);
		} else if (burst) {
			// The jiggle a box makes when the pressure inside lets go.
			const u = openT - shakeSeconds;
			const wobble = reducedMotion ? 0 : Math.exp(-7 * u) * Math.sin(u * 28);
			bodyGroup.rotation.set(0, 0, 0);
			bodyGroup.position.y = 0;
			bodyGroup.scale.set(
				1 - 0.12 * wobble,
				1 + 0.22 * wobble,
				1 - 0.12 * wobble
			);
		} else {
			const bob = reducedMotion ? 0 : Math.sin(now * 2.1) * 0.06;
			bodyGroup.rotation.set(0, 0, 0);
			bodyGroup.position.y = bob;
			const s = THREE.MathUtils.lerp(bodyGroup.scale.x, hoverScale, 0.18);
			bodyGroup.scale.set(s, s, s);
		}

		// ── Burst: lid, light, confetti ──────────────────────────────────────
		if (burst && !tl.burstFired) {
			tl.burstFired = true;
			tl.lidVelocity.set(
				(Math.random() - 0.5) * 2.4,
				reducedMotion ? 2.5 : 7.5,
				-1.2 - Math.random()
			);
			tl.lidSpin.set(
				(Math.random() - 0.5) * 9,
				(Math.random() - 0.5) * 6,
				(Math.random() - 0.5) * 9
			);
			if (!reducedMotion) {
				launchParticles(particles);
			}
			onBurstRef.current?.();
		}

		if (tl.burstFired) {
			tl.lidVelocity.y -= GRAVITY * delta;
			tl.lidPosition.addScaledVector(tl.lidVelocity, delta);
			lidGroup.position.copy(tl.lidPosition);
			lidGroup.rotation.x += tl.lidSpin.x * delta;
			lidGroup.rotation.y += tl.lidSpin.y * delta;
			lidGroup.rotation.z += tl.lidSpin.z * delta;
			lidGroup.visible = tl.lidPosition.y > -8;
		} else {
			lidGroup.position.set(0, LID_REST_Y, 0);
			lidGroup.rotation.set(0, 0, 0);
			lidGroup.visible = true;
		}

		const glowT = tl.burstFired
			? Math.min(1, (openT - shakeSeconds) / 0.35)
			: 0;
		const pulse = 0.85 + 0.15 * Math.sin(now * 5);
		if (beam.current && beamMaterial.current) {
			beam.current.visible = glowT > 0;
			beam.current.scale.set(1, Math.max(0.001, glowT), 1);
			beam.current.rotation.y += delta * 0.8;
			beamMaterial.current.opacity = glowT * 0.32 * pulse;
		}
		if (glow.current) {
			glow.current.opacity = glowT * pulse;
		}
		if (light.current) {
			light.current.intensity = glowT * 26 * pulse;
		}

		const mesh = confetti.current;
		if (mesh) {
			for (let i = 0; i < CONFETTI_COUNT; i++) {
				const particle = particles[i];
				if (!particle) {
					continue;
				}
				if (particle.life < CONFETTI_LIFE_SECONDS) {
					particle.life += delta;
					particle.velocity.y -= GRAVITY * 0.55 * delta;
					particle.velocity.multiplyScalar(1 - 0.9 * delta);
					particle.position.addScaledVector(particle.velocity, delta);
					particle.rotation.x += particle.spin.x * delta;
					particle.rotation.y += particle.spin.y * delta;
					particle.rotation.z += particle.spin.z * delta;
				}
				const fade = Math.max(0, 1 - particle.life / CONFETTI_LIFE_SECONDS);
				dummy.position.copy(particle.position);
				dummy.rotation.copy(particle.rotation);
				dummy.scale.set(
					particle.scale * fade,
					particle.scale * 0.35 * fade,
					particle.scale * fade
				);
				dummy.updateMatrix();
				mesh.setMatrixAt(i, dummy.matrix);
			}
			mesh.instanceMatrix.needsUpdate = true;
		}
	});

	const handleClick = (event: ThreeEvent<MouseEvent>) => {
		event.stopPropagation();
		if (!opening) {
			onActivate?.();
		}
	};

	const faces: Array<{
		position: [number, number, number];
		rotation: [number, number, number];
	}> = [
		{ position: [0, 0, BODY_HALF + 0.002], rotation: [0, 0, 0] },
		{ position: [0, 0, -BODY_HALF - 0.002], rotation: [0, Math.PI, 0] },
		{ position: [BODY_HALF + 0.002, 0, 0], rotation: [0, Math.PI / 2, 0] },
		{ position: [-BODY_HALF - 0.002, 0, 0], rotation: [0, -Math.PI / 2, 0] },
	];

	return (
		<group ref={root}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: three.js scene graph, not DOM — the dialog carries a real button for keyboard users. */}
			<group
				onClick={handleClick}
				onPointerOut={() => setHovered(false)}
				onPointerOver={(event) => {
					event.stopPropagation();
					setHovered(true);
				}}
				ref={body}
			>
				<RoundedBox
					args={[BODY_HALF * 2, BODY_HEIGHT, BODY_HALF * 2]}
					radius={0.07}
					smoothness={4}
				>
					<meshPhysicalMaterial
						clearcoat={1}
						clearcoatRoughness={0.25}
						color={boxColor}
						metalness={0.15}
						roughness={0.35}
					/>
				</RoundedBox>
				{/* Vertical ribbons down each side. */}
				<mesh>
					<boxGeometry
						args={[0.26, BODY_HEIGHT + 0.01, BODY_HALF * 2 + 0.02]}
					/>
					<meshStandardMaterial
						color={accent}
						emissive={accent}
						emissiveIntensity={0.25}
						metalness={0.55}
						roughness={0.28}
					/>
				</mesh>
				<mesh>
					<boxGeometry
						args={[BODY_HALF * 2 + 0.02, BODY_HEIGHT + 0.01, 0.26]}
					/>
					<meshStandardMaterial
						color={accent}
						emissive={accent}
						emissiveIntensity={0.25}
						metalness={0.55}
						roughness={0.28}
					/>
				</mesh>
				{questionMark
					? faces.map((face) => (
							<mesh
								key={face.position.join(",")}
								position={[
									face.position[0] * 1.02,
									0.02,
									face.position[2] * 1.02,
								]}
								rotation={face.rotation}
							>
								<planeGeometry args={[0.95, 0.95]} />
								<meshBasicMaterial
									depthWrite={false}
									map={questionMark}
									toneMapped={false}
									transparent
								/>
							</mesh>
						))
					: null}
				{/* What spills out of the open top. */}
				<mesh
					position={[0, LID_REST_Y + 0.004, 0]}
					rotation={[-Math.PI / 2, 0, 0]}
				>
					<planeGeometry args={[BODY_HALF * 1.9, BODY_HALF * 1.9]} />
					<meshBasicMaterial
						color={accent}
						opacity={0}
						ref={glow}
						toneMapped={false}
						transparent
					/>
				</mesh>
				<pointLight
					color={accent}
					distance={8}
					intensity={0}
					position={[0, LID_REST_Y + 0.6, 0]}
					ref={light}
				/>
			</group>

			<group ref={lid}>
				<RoundedBox
					args={[BODY_HALF * 2 + 0.12, 0.3, BODY_HALF * 2 + 0.12]}
					position={[0, 0.15, 0]}
					radius={0.06}
					smoothness={4}
				>
					<meshPhysicalMaterial
						clearcoat={1}
						clearcoatRoughness={0.25}
						color={boxColor}
						metalness={0.15}
						roughness={0.35}
					/>
				</RoundedBox>
				<mesh position={[0, 0.15, 0]}>
					<boxGeometry args={[0.28, 0.32, BODY_HALF * 2 + 0.14]} />
					<meshStandardMaterial
						color={accent}
						emissive={accent}
						emissiveIntensity={0.25}
						metalness={0.55}
						roughness={0.28}
					/>
				</mesh>
				<mesh position={[0, 0.15, 0]}>
					<boxGeometry args={[BODY_HALF * 2 + 0.14, 0.32, 0.28]} />
					<meshStandardMaterial
						color={accent}
						emissive={accent}
						emissiveIntensity={0.25}
						metalness={0.55}
						roughness={0.28}
					/>
				</mesh>
				{/* The bow. */}
				<mesh position={[-0.24, 0.48, 0]} rotation={[0, 0, 0.55]}>
					<torusGeometry args={[0.22, 0.075, 14, 36]} />
					<meshStandardMaterial
						color={accent}
						emissive={accent}
						emissiveIntensity={0.3}
						metalness={0.5}
						roughness={0.3}
					/>
				</mesh>
				<mesh position={[0.24, 0.48, 0]} rotation={[0, 0, -0.55]}>
					<torusGeometry args={[0.22, 0.075, 14, 36]} />
					<meshStandardMaterial
						color={accent}
						emissive={accent}
						emissiveIntensity={0.3}
						metalness={0.5}
						roughness={0.3}
					/>
				</mesh>
				<mesh position={[0, 0.36, 0]}>
					<sphereGeometry args={[0.11, 20, 20]} />
					<meshStandardMaterial
						color={accent}
						emissive={accent}
						emissiveIntensity={0.3}
						metalness={0.5}
						roughness={0.3}
					/>
				</mesh>
			</group>

			{/* The beam of light out of the open box. The group sits at the box's
			    mouth and scales from there, so the beam grows UP out of it. */}
			<group position={[0, LID_REST_Y, 0]} ref={beam} visible={false}>
				<mesh position={[0, 2.5, 0]}>
					<cylinderGeometry args={[1.5, 0.7, 5, 32, 1, true]} />
					<meshBasicMaterial
						blending={THREE.AdditiveBlending}
						color={accent}
						depthWrite={false}
						opacity={0}
						ref={beamMaterial}
						side={THREE.DoubleSide}
						toneMapped={false}
						transparent
					/>
				</mesh>
			</group>
			<instancedMesh
				args={[undefined, undefined, CONFETTI_COUNT]}
				frustumCulled={false}
				ref={confetti}
			>
				<boxGeometry args={[1, 1, 1]} />
				<meshStandardMaterial
					metalness={0.4}
					roughness={0.35}
					toneMapped={false}
				/>
			</instancedMesh>
		</group>
	);
}

export default function MysteryBoxScene({
	accent = "#a855f7",
	boxColor = "#1f1b2e",
	className,
	onActivate,
	onBurst,
	opening,
	reducedMotion = false,
	round,
}: MysteryBoxSceneProps) {
	return (
		<div className={className}>
			<Canvas
				camera={{ fov: 32, position: [0, 2.1, 6.4] }}
				dpr={[1, 2]}
				gl={{ alpha: true, antialias: true }}
				onCreated={({ gl }) => gl.setClearColor(new THREE.Color(0x00_00_00), 0)}
			>
				<CameraAim />
				<ambientLight intensity={0.6} />
				<directionalLight intensity={2.2} position={[3, 5, 4]} />
				<directionalLight
					color={accent}
					intensity={0.8}
					position={[-4, 2, -3]}
				/>
				<GiftBox
					accent={accent}
					boxColor={boxColor}
					onActivate={onActivate}
					onBurst={onBurst}
					opening={opening}
					reducedMotion={reducedMotion}
					round={round}
				/>
				<ContactShadows
					blur={2.4}
					far={3}
					opacity={0.45}
					position={[0, -BODY_HEIGHT / 2 - 0.02, 0]}
					scale={6}
				/>
				<Environment resolution={256}>
					<Lightformer
						color="white"
						intensity={2}
						position={[0, 3, 4]}
						rotation={[0, 0, Math.PI / 3]}
						scale={[10, 0.4, 1]}
					/>
					<Lightformer
						color="white"
						intensity={3}
						position={[-4, 1, 2]}
						rotation={[0, Math.PI / 2, 0]}
						scale={[10, 2, 1]}
					/>
					<Lightformer
						color={accent}
						intensity={1.5}
						position={[4, 0, -2]}
						rotation={[0, -Math.PI / 2, 0]}
						scale={[10, 2, 1]}
					/>
				</Environment>
			</Canvas>
		</div>
	);
}
