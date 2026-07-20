/* eslint-disable react/no-unknown-property */
"use client";
import {
	Environment,
	Lightformer,
	useGLTF,
	useTexture,
} from "@react-three/drei";
import { Canvas, extend, useFrame } from "@react-three/fiber";
import {
	BallCollider,
	CuboidCollider,
	Physics,
	type RapierRigidBody,
	RigidBody,
	useRopeJoint,
	useSphericalJoint,
} from "@react-three/rapier";
import {
	MeshLineGeometry,
	MeshLineMaterial,
	type MeshLineMaterialParameters,
} from "meshline";
import {
	type CSSProperties,
	type RefObject,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import * as THREE from "three";
// Replace with your own imports, see the usage snippet for details.
import cardGLB from "./card.glb";
import "./Lanyard.css";
import lanyard from "./lanyard.png";

extend({ MeshLineGeometry, MeshLineMaterial });

// 1x1 transparent pixel — lets useTexture be called unconditionally when a
// front/back image isn't supplied.
const BLANK_PIXEL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// The card model's front face is UV-mapped to the LEFT half of the texture
// atlas and the back face to the RIGHT half (measured from card.glb). Each
// custom image is composited into its own half so the two faces render
// independently, aspect-preserving (no stretching).
const FRONT_UV_RECT = { x: 0, y: 0, w: 0.5, h: 0.755 };
const BACK_UV_RECT = { x: 0.5, y: 0, w: 0.5, h: 0.757 };

interface UvRect {
	h: number;
	w: number;
	x: number;
	y: number;
}

/** Shape of the card model once loaded — only the meshes/materials we touch. */
interface CardGLTF {
	materials: {
		base: THREE.MeshPhysicalMaterial;
		metal: THREE.MeshStandardMaterial;
	};
	nodes: {
		card: THREE.Mesh;
		clip: THREE.Mesh;
		clamp: THREE.Mesh;
	};
}

export interface LanyardProps {
	/** Custom image URL for the card's back face. */
	backImage?: string | null;
	/** Extra class on the wrapper element. */
	className?: string;
	fov?: number;
	/** Custom image URL for the card's front face. */
	frontImage?: string | null;
	gravity?: [number, number, number];
	/** How a custom front/back image fits its face. */
	imageFit?: "cover" | "contain";
	/** Custom image URL for the lanyard band's repeating texture. */
	lanyardImage?: string | null;
	/** Width of the lanyard band (meshline lineWidth). */
	lanyardWidth?: number;
	position?: [number, number, number];
	/** Inline style on the wrapper (e.g. to set `--lanyard-height`). */
	style?: CSSProperties;
	transparent?: boolean;
}

export default function Lanyard({
	position = [0, 0, 30],
	gravity = [0, -40, 0],
	fov = 20,
	transparent = true,
	frontImage = null,
	backImage = null,
	imageFit = "cover",
	lanyardImage = null,
	lanyardWidth = 1,
	className,
	style,
}: LanyardProps) {
	const [isMobile, setIsMobile] = useState(
		() => typeof window !== "undefined" && window.innerWidth < 768
	);

	useEffect(() => {
		const handleResize = () => setIsMobile(window.innerWidth < 768);
		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, []);

	return (
		<div
			className={["lanyard-wrapper", className].filter(Boolean).join(" ")}
			style={style}
		>
			<Canvas
				camera={{ position, fov }}
				dpr={[1, isMobile ? 1.5 : 2]}
				gl={{ alpha: transparent }}
				onCreated={({ gl }) =>
					gl.setClearColor(new THREE.Color(0x00_00_00), transparent ? 0 : 1)
				}
			>
				<ambientLight intensity={Math.PI} />
				<Physics gravity={gravity} timeStep={isMobile ? 1 / 30 : 1 / 60}>
					<Band
						backImage={backImage}
						frontImage={frontImage}
						imageFit={imageFit}
						isMobile={isMobile}
						lanyardImage={lanyardImage}
						lanyardWidth={lanyardWidth}
					/>
				</Physics>
				<Environment blur={0.75}>
					<Lightformer
						color="white"
						intensity={2}
						position={[0, -1, 5]}
						rotation={[0, 0, Math.PI / 3]}
						scale={[100, 0.1, 1]}
					/>
					<Lightformer
						color="white"
						intensity={3}
						position={[-1, -1, 1]}
						rotation={[0, 0, Math.PI / 3]}
						scale={[100, 0.1, 1]}
					/>
					<Lightformer
						color="white"
						intensity={3}
						position={[1, 1, 1]}
						rotation={[0, 0, Math.PI / 3]}
						scale={[100, 0.1, 1]}
					/>
					<Lightformer
						color="white"
						intensity={10}
						position={[-10, 0, 14]}
						rotation={[0, Math.PI / 2, Math.PI / 3]}
						scale={[100, 10, 1]}
					/>
				</Environment>
			</Canvas>
		</div>
	);
}

interface BandProps {
	backImage?: string | null;
	frontImage?: string | null;
	imageFit?: "cover" | "contain";
	isMobile?: boolean;
	lanyardImage?: string | null;
	lanyardWidth?: number;
	maxSpeed?: number;
	minSpeed?: number;
}

function Band({
	maxSpeed = 50,
	minSpeed = 0,
	isMobile = false,
	frontImage = null,
	backImage = null,
	imageFit = "cover",
	lanyardImage = null,
	lanyardWidth = 1,
}: BandProps) {
	const band = useRef<THREE.Mesh>(null);
	const fixed = useRef<RapierRigidBody>(null);
	const j1 = useRef<RapierRigidBody>(null);
	const j2 = useRef<RapierRigidBody>(null);
	const j3 = useRef<RapierRigidBody>(null);
	const card = useRef<RapierRigidBody>(null);
	// Smoothed positions for the two middle joints, keyed by their rigid body —
	// kept off the body object so the refs stay plain RapierRigidBody.
	const lerped = useRef(new WeakMap<RapierRigidBody, THREE.Vector3>());
	const vec = new THREE.Vector3();
	const ang = new THREE.Vector3();
	const rot = new THREE.Vector3();
	const dir = new THREE.Vector3();
	const tmp = new THREE.Vector3();
	const segmentProps = {
		type: "dynamic",
		canSleep: true,
		colliders: false,
		angularDamping: 4,
		linearDamping: 4,
	} as const;
	const { nodes, materials } = useGLTF(cardGLB) as unknown as CardGLTF;
	const texture = useTexture(lanyardImage || lanyard);
	// useTexture must be called unconditionally; use a blank pixel when an image
	// isn't supplied for a given face, then skip compositing it below.
	const frontTex = useTexture(frontImage || BLANK_PIXEL);
	const backTex = useTexture(backImage || BLANK_PIXEL);

	// Composite the front/back images into the card's texture atlas (front = left
	// half, back = right half). Each image is drawn aspect-preserving (no stretch).
	const cardMap = useMemo(() => {
		const baseMap = materials.base.map;
		if (!(baseMap && (frontImage || backImage))) {
			return baseMap;
		}

		const baseImg = baseMap.image;
		// Supersample the composite atlas so the card face isn't upscaled (and
		// blurred) when the badge is shown large on a high-DPR display. The GLB's
		// baked atlas is small, so compositing at its native size and then blowing
		// the card up on screen is what made it look soft. UVs are normalized, so
		// scaling the whole canvas uniformly keeps the mapping exact.
		const srcW = baseImg.width as number;
		const srcH = baseImg.height as number;
		const TARGET_ATLAS = 2048;
		const superScale = Math.max(
			1,
			Math.ceil(TARGET_ATLAS / Math.max(srcW, srcH))
		);
		const W = srcW * superScale;
		const H = srcH * superScale;
		const canvas = document.createElement("canvas");
		canvas.width = W;
		canvas.height = H;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return baseMap;
		}
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";
		// Keep the original baked atlas for the card edges and any untouched face.
		ctx.drawImage(baseImg as CanvasImageSource, 0, 0, W, H);

		const drawFitted = (img: CanvasImageSource, rect: UvRect) => {
			const imgW = (img as HTMLImageElement).width;
			const imgH = (img as HTMLImageElement).height;
			const rx = rect.x * W;
			const ry = rect.y * H;
			const rw = rect.w * W;
			const rh = rect.h * H;
			const pick = imageFit === "contain" ? Math.min : Math.max;
			const scale = pick(rw / imgW, rh / imgH);
			const dw = imgW * scale;
			const dh = imgH * scale;
			const dx = rx + (rw - dw) / 2;
			const dy = ry + (rh - dh) / 2;
			ctx.save();
			ctx.beginPath();
			ctx.rect(rx, ry, rw, rh);
			ctx.clip();
			ctx.drawImage(img, dx, dy, dw, dh);
			ctx.restore();
		};

		if (frontImage && frontTex.image) {
			drawFitted(frontTex.image as CanvasImageSource, FRONT_UV_RECT);
		}
		if (backImage && backTex.image) {
			drawFitted(backTex.image as CanvasImageSource, BACK_UV_RECT);
		}

		const composite = new THREE.CanvasTexture(canvas);
		composite.colorSpace = THREE.SRGBColorSpace;
		composite.flipY = baseMap.flipY;
		composite.anisotropy = 16;
		composite.needsUpdate = true;
		return composite;
	}, [frontImage, backImage, imageFit, frontTex, backTex, materials.base.map]);

	const [curve] = useState(
		() =>
			new THREE.CatmullRomCurve3([
				new THREE.Vector3(),
				new THREE.Vector3(),
				new THREE.Vector3(),
				new THREE.Vector3(),
			])
	);
	const [dragged, drag] = useState<false | THREE.Vector3>(false);
	const [hovered, hover] = useState(false);

	// rapier's joint hooks type their body refs as non-null RefObject; our refs
	// start null at runtime, so narrow the type for the hook call sites only.
	const asBody = (r: RefObject<RapierRigidBody | null>) =>
		r as RefObject<RapierRigidBody>;
	useRopeJoint(asBody(fixed), asBody(j1), [[0, 0, 0], [0, 0, 0], 1]);
	useRopeJoint(asBody(j1), asBody(j2), [[0, 0, 0], [0, 0, 0], 1]);
	useRopeJoint(asBody(j2), asBody(j3), [[0, 0, 0], [0, 0, 0], 1]);
	useSphericalJoint(asBody(j3), asBody(card), [
		[0, 0, 0],
		[0, 1.5, 0],
	]);

	useEffect(() => {
		if (hovered) {
			document.body.style.cursor = dragged ? "grabbing" : "grab";
			return () => {
				document.body.style.cursor = "auto";
			};
		}
	}, [hovered, dragged]);

	useFrame((state, delta) => {
		if (dragged) {
			vec.set(state.pointer.x, state.pointer.y, 0.5).unproject(state.camera);
			dir.copy(vec).sub(state.camera.position).normalize();
			vec.add(dir.multiplyScalar(state.camera.position.length()));
			for (const ref of [card, j1, j2, j3, fixed]) {
				ref.current?.wakeUp();
			}
			card.current?.setNextKinematicTranslation({
				x: vec.x - dragged.x,
				y: vec.y - dragged.y,
				z: vec.z - dragged.z,
			});
		}
		if (fixed.current) {
			for (const ref of [j1, j2]) {
				const rb = ref.current;
				if (!rb) {
					continue;
				}
				const t = rb.translation();
				let lp = lerped.current.get(rb);
				if (!lp) {
					lp = new THREE.Vector3(t.x, t.y, t.z);
					lerped.current.set(rb, lp);
				}
				tmp.set(t.x, t.y, t.z);
				const clampedDistance = Math.max(0.1, Math.min(1, lp.distanceTo(tmp)));
				lp.lerp(
					tmp,
					delta * (minSpeed + clampedDistance * (maxSpeed - minSpeed))
				);
			}
			const [p0, p1, p2, p3] = curve.points;
			const c = card.current;
			const a = j1.current;
			const b = j2.current;
			const d = j3.current;
			const aL = a ? lerped.current.get(a) : undefined;
			const bL = b ? lerped.current.get(b) : undefined;
			if (p0 && p1 && p2 && p3 && c && aL && bL && d) {
				const dt = d.translation();
				p0.set(dt.x, dt.y, dt.z);
				p1.copy(bL);
				p2.copy(aL);
				const ft = fixed.current.translation();
				p3.set(ft.x, ft.y, ft.z);
				if (band.current) {
					(band.current.geometry as MeshLineGeometry).setPoints(
						curve.getPoints(isMobile ? 16 : 32)
					);
				}
				const av = c.angvel();
				const cr = c.rotation();
				ang.set(av.x, av.y, av.z);
				rot.set(cr.x, cr.y, cr.z);
				c.setAngvel({ x: ang.x, y: ang.y - rot.y * 0.25, z: ang.z }, true);
			}
		}
	});

	curve.curveType = "chordal";
	texture.wrapS = THREE.RepeatWrapping;
	texture.wrapT = THREE.RepeatWrapping;

	return (
		<>
			<group position={[0, 4, 0]}>
				<RigidBody ref={fixed} {...segmentProps} type="fixed" />
				<RigidBody position={[0.5, 0, 0]} ref={j1} {...segmentProps}>
					<BallCollider args={[0.1]} />
				</RigidBody>
				<RigidBody position={[1, 0, 0]} ref={j2} {...segmentProps}>
					<BallCollider args={[0.1]} />
				</RigidBody>
				<RigidBody position={[1.5, 0, 0]} ref={j3} {...segmentProps}>
					<BallCollider args={[0.1]} />
				</RigidBody>
				<RigidBody
					position={[2, 0, 0]}
					ref={card}
					{...segmentProps}
					type={dragged ? "kinematicPosition" : "dynamic"}
				>
					<CuboidCollider args={[0.8, 1.125, 0.01]} />
					<group
						onPointerDown={(e) => {
							const el = e.target as Element;
							el.setPointerCapture(e.pointerId);
							const t = card.current?.translation();
							if (!t) {
								return;
							}
							drag(
								new THREE.Vector3().copy(e.point).sub(vec.set(t.x, t.y, t.z))
							);
						}}
						onPointerOut={() => hover(false)}
						onPointerOver={() => hover(true)}
						onPointerUp={(e) => {
							(e.target as Element).releasePointerCapture(e.pointerId);
							drag(false);
						}}
						position={[0, -1.2, -0.05]}
						scale={2.25}
					>
						<mesh geometry={nodes.card.geometry}>
							<meshPhysicalMaterial
								clearcoat={isMobile ? 0 : 1}
								clearcoatRoughness={0.15}
								map={cardMap}
								map-anisotropy={16}
								metalness={0.8}
								roughness={0.9}
							/>
						</mesh>
						<mesh
							geometry={nodes.clip.geometry}
							material={materials.metal}
							material-roughness={0.3}
						/>
						<mesh geometry={nodes.clamp.geometry} material={materials.metal} />
					</group>
				</RigidBody>
			</group>
			<mesh ref={band}>
				<meshLineGeometry />
				<meshLineMaterial
					args={[
						{
							resolution: new THREE.Vector2(1000, 1000),
						} as MeshLineMaterialParameters,
					]}
					color="white"
					depthTest={false}
					lineWidth={lanyardWidth}
					map={texture}
					repeat={[-4, 1]}
					resolution={isMobile ? [1000, 2000] : [1000, 1000]}
					useMap={1}
				/>
			</mesh>
		</>
	);
}

useGLTF.preload(cardGLB);
