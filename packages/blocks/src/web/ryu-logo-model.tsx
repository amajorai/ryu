/* eslint-disable react/no-unknown-property */
"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Logo } from "@ryu/ui/components/logo.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";

import styles from "./ryu-logo-model.module.css";

const RYU_MODEL_SCALE = 0.22;
const RYU_MASK_SIZE = 512;
const RYU_MASK_PADDING = 0.1;
const RYU_CURVE_SEGMENTS = 64;
const RYU_MODEL_COLOR = "#929292";
const RYU_EYE_CENTER_Y = 10;
const RYU_EYE_RADIUS_X = 1.5;
const RYU_EYE_RADIUS_Y = 3;

/**
 * The same Ryu outline used by the shared logo, mapped into Three's Y-up
 * coordinate system. The eye paths are holes in the volume, so the
 * background really passes through them instead of being painted over.
 */
function createRyuContour() {
	const contour = new THREE.Shape();

	contour.moveTo(12, 24);
	contour.bezierCurveTo(21.2, 24, 24.9, 19.2, 24.4, 9.4);
	contour.bezierCurveTo(24.1, 0.3, 12.8, -3.7, 8.8, 5.4);
	contour.bezierCurveTo(6.6, 11.1, 9.9, 13.3, 5.9, 18);
	contour.bezierCurveTo(5, 19.1, 4.1, 20, 3.2, 21.1);
	contour.bezierCurveTo(2, 22.4, 3.9, 23.3, 5.1, 23.3);
	contour.bezierCurveTo(7.4, 23.3, 9.7, 24, 12, 24);

	const leftEye = new THREE.Path();
	leftEye.absellipse(
		15,
		RYU_EYE_CENTER_Y,
		RYU_EYE_RADIUS_X,
		RYU_EYE_RADIUS_Y,
		0,
		Math.PI * 2,
		true,
		0
	);
	const rightEye = new THREE.Path();
	rightEye.absellipse(
		19,
		RYU_EYE_CENTER_Y,
		RYU_EYE_RADIUS_X,
		RYU_EYE_RADIUS_Y,
		0,
		Math.PI * 2,
		true,
		0
	);
	contour.holes.push(leftEye, rightEye);

	return contour;
}

const RYU_CONTOUR = createRyuContour();

function isPointInsidePolygon(
	x: number,
	y: number,
	polygon: readonly THREE.Vector2[]
) {
	let inside = false;

	let previousPoint = polygon.at(-1);
	if (!previousPoint) {
		return false;
	}
	for (const currentPoint of polygon) {
		const crossesScanline =
			currentPoint.y > y !== previousPoint.y > y &&
			x <
				((previousPoint.x - currentPoint.x) * (y - currentPoint.y)) /
					(previousPoint.y - currentPoint.y) +
					currentPoint.x;

		if (crossesScanline) {
			inside = !inside;
		}
		previousPoint = currentPoint;
	}

	return inside;
}

function createRyuMaskTexture() {
	const { holes, shape: contour } =
		RYU_CONTOUR.extractPoints(RYU_CURVE_SEGMENTS);
	const contourBounds = new THREE.Box2().setFromPoints(contour);
	const contourWidth = contourBounds.max.x - contourBounds.min.x;
	const contourHeight = contourBounds.max.y - contourBounds.min.y;
	const padding = Math.max(contourWidth, contourHeight) * RYU_MASK_PADDING;
	const bounds = new THREE.Box2(
		new THREE.Vector2(
			contourBounds.min.x - padding,
			contourBounds.min.y - padding
		),
		new THREE.Vector2(
			contourBounds.max.x + padding,
			contourBounds.max.y + padding
		)
	);
	const width = bounds.max.x - bounds.min.x;
	const height = bounds.max.y - bounds.min.y;
	const data = new Uint8Array(RYU_MASK_SIZE * RYU_MASK_SIZE * 4);

	for (let y = 0; y < RYU_MASK_SIZE; y += 1) {
		const pointY = bounds.max.y - ((y + 0.5) / RYU_MASK_SIZE) * height;

		for (let x = 0; x < RYU_MASK_SIZE; x += 1) {
			const pointX = bounds.min.x + ((x + 0.5) / RYU_MASK_SIZE) * width;
			const visible =
				isPointInsidePolygon(pointX, pointY, contour) &&
				!holes.some((hole) => isPointInsidePolygon(pointX, pointY, hole));
			const value = visible ? 255 : 0;
			const offset = (y * RYU_MASK_SIZE + x) * 4;

			data[offset] = value;
			data[offset + 1] = value;
			data[offset + 2] = value;
			data[offset + 3] = value;
		}
	}

	const texture = new THREE.DataTexture(
		data,
		RYU_MASK_SIZE,
		RYU_MASK_SIZE,
		THREE.RGBAFormat
	);
	texture.magFilter = THREE.LinearFilter;
	texture.minFilter = THREE.LinearFilter;
	texture.needsUpdate = true;
	texture.wrapS = THREE.ClampToEdgeWrapping;
	texture.wrapT = THREE.ClampToEdgeWrapping;

	return { bounds, texture };
}

function RyuLogoMesh() {
	const geometry = useMemo(() => new THREE.SphereGeometry(1, 96, 64), []);
	const eyeRingGeometry = useMemo(
		() => new THREE.TorusGeometry(1, 0.045, 12, 64),
		[]
	);
	const { bounds, texture } = useMemo(createRyuMaskTexture, []);
	const material = useMemo(() => {
		const modelMaterial = new THREE.MeshPhysicalMaterial({
			clearcoat: 0.16,
			clearcoatRoughness: 0.38,
			color: RYU_MODEL_COLOR,
			metalness: 0,
			roughness: 0.5,
		});

		modelMaterial.onBeforeCompile = (shader) => {
			shader.uniforms.uRyuMask = { value: texture };
			shader.vertexShader = shader.vertexShader
				.replace(
					"#include <common>",
					"#include <common>\nvarying vec2 vRyuMaskUv;"
				)
				.replace(
					"#include <begin_vertex>",
					"#include <begin_vertex>\nvRyuMaskUv = position.xy * 0.5 + 0.5;"
				);
			shader.fragmentShader = shader.fragmentShader
				.replace(
					"#include <common>",
					"#include <common>\nvarying vec2 vRyuMaskUv;\nuniform sampler2D uRyuMask;"
				)
				.replace(
					"void main() {",
					"void main() {\n\tif (texture2D(uRyuMask, vRyuMaskUv).r < 0.5) discard;"
				);
		};
		modelMaterial.customProgramCacheKey = () => "ryu-spherical-mask";
		return modelMaterial;
	}, [texture]);
	const eyeMaterial = useMemo(
		() =>
			new THREE.MeshPhysicalMaterial({
				clearcoat: 0.16,
				clearcoatRoughness: 0.38,
				color: RYU_MODEL_COLOR,
				metalness: 0,
				roughness: 0.5,
			}),
		[]
	);
	const scale = useMemo(() => {
		const width = bounds.max.x - bounds.min.x;
		const height = bounds.max.y - bounds.min.y;
		const depth = Math.max(width, height);

		return [
			(width / 2) * RYU_MODEL_SCALE,
			(height / 2) * RYU_MODEL_SCALE,
			(depth / 2) * RYU_MODEL_SCALE,
		] as const;
	}, [bounds]);
	const eyes = useMemo(() => {
		const width = bounds.max.x - bounds.min.x;
		const height = bounds.max.y - bounds.min.y;
		const normalizedEye = (x: number, y: number) => {
			const positionX = ((x - bounds.min.x) / width) * 2 - 1;
			const positionY = ((bounds.max.y - y) / height) * 2 - 1;
			const positionZ = Math.sqrt(
				Math.max(0.2, 1 - positionX ** 2 - positionY ** 2)
			);

			return {
				position: [positionX, positionY, positionZ - 0.03] as const,
				scale: [
					(RYU_EYE_RADIUS_X / width) * 2,
					(RYU_EYE_RADIUS_Y / height) * 2,
					1,
				] as const,
			};
		};

		return [
			normalizedEye(15, RYU_EYE_CENTER_Y),
			normalizedEye(19, RYU_EYE_CENTER_Y),
		];
	}, [bounds]);

	useEffect(
		() => () => {
			geometry.dispose();
			eyeRingGeometry.dispose();
			material.dispose();
			eyeMaterial.dispose();
			texture.dispose();
		},
		[eyeMaterial, eyeRingGeometry, geometry, material, texture]
	);

	return (
		<group scale={scale}>
			<mesh castShadow geometry={geometry} material={material} receiveShadow />
			{eyes.map(({ position, scale: eyeScale }, index) => (
				<mesh
					castShadow
					geometry={eyeRingGeometry}
					key={`eye-ring-${index}`}
					material={eyeMaterial}
					position={position}
					scale={eyeScale}
				/>
			))}
		</group>
	);
}

function RyuLogoScene({
	decorative,
	isDragging,
	onDragEnd,
	onDragStart,
	reducedMotion,
}: {
	decorative: boolean;
	isDragging: boolean;
	onDragEnd: () => void;
	onDragStart: () => void;
	reducedMotion: boolean;
}) {
	return (
		<>
			<ambientLight intensity={1.4} />
			<hemisphereLight args={["#ffffff", "#999999", 1.1]} />
			<directionalLight
				castShadow
				color={new THREE.Color(1, 1, 1)}
				intensity={2.8}
				position={[4, 6, 8]}
			/>
			<pointLight
				color={new THREE.Color(1, 1, 1)}
				intensity={7}
				position={[-4, 1, 5]}
			/>

			<group rotation={[0.02, -0.14, 0]}>
				<RyuLogoMesh />
			</group>

			<OrbitControls
				autoRotate={!(decorative || reducedMotion || isDragging)}
				autoRotateSpeed={0.7}
				dampingFactor={0.08}
				enableDamping
				enablePan={false}
				enableZoom={false}
				maxPolarAngle={Math.PI / 2 + 0.62}
				minPolarAngle={Math.PI / 2 - 0.62}
				onEnd={onDragEnd}
				onStart={onDragStart}
				rotateSpeed={0.72}
			/>
		</>
	);
}

function useReducedMotion() {
	const [reducedMotion, setReducedMotion] = useState(false);

	useEffect(() => {
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setReducedMotion(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);

	return reducedMotion;
}

type WebGLCanvas = Pick<HTMLCanvasElement, "getContext">;

export function supportsWebGL(
	createCanvas: () => WebGLCanvas = () => document.createElement("canvas")
): boolean {
	try {
		const canvas = createCanvas();
		return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
	} catch {
		return false;
	}
}

function useWebGLSupport() {
	const [supported, setSupported] = useState(false);

	useEffect(() => {
		setSupported(supportsWebGL());
	}, []);

	return supported;
}

interface RyuLogoModelProps {
	className?: string;
	decorative?: boolean;
}

export default function RyuLogoModel({
	className,
	decorative = false,
}: RyuLogoModelProps) {
	const reducedMotion = useReducedMotion();
	const webGLSupported = useWebGLSupport();
	const [isDragging, setIsDragging] = useState(false);

	return (
		<figure
			aria-hidden={decorative ? true : undefined}
			className={cn(styles.root, className)}
		>
			<div
				aria-label="Interactive three-dimensional filled Ryu logo with transparent eyes"
				className={styles.stage}
				data-dragging={isDragging}
				role="img"
			>
				<div aria-hidden="true" className={styles.atmosphere} />
				<div aria-hidden="true" className={styles.orbit} />
				{webGLSupported ? (
					<Canvas
						camera={{ fov: 36, position: [0, 0, 11] }}
						className={styles.canvas}
						dpr={[1, 2]}
						gl={{ alpha: true, antialias: true }}
						shadows
					>
						<RyuLogoScene
							decorative={decorative}
							isDragging={isDragging}
							onDragEnd={() => setIsDragging(false)}
							onDragStart={() => setIsDragging(true)}
							reducedMotion={reducedMotion}
						/>
					</Canvas>
				) : (
					<div className={styles.fallback}>
						<Logo animated={false} size="100%" variant="filled" />
					</div>
				)}
				<div aria-hidden="true" className={styles.shadow} />
			</div>
			{decorative ? null : (
				<>
					<figcaption className={styles.caption}>
						<span>
							<strong>Ryu / Filled form</strong>
							<br />
							Body solid · eyes transparent
						</span>
						<span className={styles.hint}>
							{webGLSupported
								? isDragging
									? "Release to let it drift"
									: "Drag to rotate"
								: "Static preview"}
						</span>
					</figcaption>
					<p className="sr-only">
						{webGLSupported
							? "This is a real 3D model. Drag the logo to rotate it and inspect the transparent eye cutouts."
							: "This browser cannot display the interactive 3D model, so a static Ryu logo is shown instead."}
					</p>
				</>
			)}
		</figure>
	);
}
