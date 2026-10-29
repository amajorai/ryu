"use client";

import type { CSSProperties } from "react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	AmbientLight,
	DirectionalLight,
	Group,
	Mesh,
	MeshPhysicalMaterial,
	PerspectiveCamera,
	Scene,
	SphereGeometry,
} from "three";
import { isNativeNumber } from "../lib/native-primitive-observation.ts";
import { cn } from "../lib/utils.ts";
import {
	blendExpressiveFrames,
	expressiveFrame,
	randomExpressiveExpression,
} from "./expressive.ts";
import { expressiveAnimationPreviewTime } from "./expressive-animation.ts";
import type { LogoProps } from "./logo.tsx";
import drawingStyles from "./logo-3d.drawing.module.css";
import { sampleGhostAnimation } from "./logo-3d-animation.ts";
import { createGhostDecorations } from "./logo-3d-decorations.ts";
import { createGhostFace } from "./logo-3d-face.ts";
import { createGhostGeometry } from "./logo-3d-geometry.ts";
import { createGhostBodyMaterial } from "./logo-3d-material.ts";
import { createGhostRenderer } from "./logo-3d-renderer.ts";

interface LogoContainerStyle extends CSSProperties {
	"--logo-3d-1-cursor"?: CSSProperties["cursor"];
	"--logo-3d-1-height"?: string | undefined;
	"--logo-3d-1-position"?: CSSProperties["position"];
	"--logo-3d-1-width"?: string | undefined;
}
interface LogoViewportStyle extends CSSProperties {
	"--logo-3d-2-inset"?: CSSProperties["inset"];
	"--logo-3d-2-position"?: CSSProperties["position"];
}
function drawingLength(value: CSSProperties["width"]): string | undefined {
	return isNativeNumber(value) ? `${value}px` : value;
}

export default function Logo3D({
	size = "192px",
	className,
	animated = true,
	animation = "idle",
	animationDuration = 20,
	bodyStyle = "solid",
	showEyes = true,
	eyeScale = 1,
	expression = "neutral",
	colors,
	fallback,
}: LogoProps & { fallback: ReactNode }) {
	const host = useRef<HTMLDivElement>(null);
	const [ready, setReady] = useState(false);
	const expressionRef = useRef(expression);
	const animationRef = useRef(animation);
	const updateFace = useRef<(() => void) | null>(null);
	useEffect(() => {
		const element = host.current;
		if (!element) {
			return;
		}
		let renderer: ReturnType<typeof createGhostRenderer>;
		try {
			renderer = createGhostRenderer();
		} catch {
			setReady(false);
			return;
		}
		const canvas = renderer.domElement;
		canvas.style.cssText =
			"width:100%;height:100%;display:block;touch-action:pan-y";
		canvas.setAttribute("role", "img");
		canvas.setAttribute(
			"aria-label",
			animated
				? "Ryu 3D ghost. Drag or use left and right arrow keys to rotate."
				: "Ryu 3D ghost"
		);
		if (animated) {
			canvas.tabIndex = 0;
		}
		element.append(canvas);
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		const scene = new Scene();
		const camera = new PerspectiveCamera(34, 1, 0.1, 200);
		camera.position.set(0, 0, 52);
		const bodyGeometry = createGhostGeometry();
		const bodySurface = createGhostBodyMaterial(bodyStyle, colors);
		const bodyMaterial = bodySurface.material;
		const ghost = new Group();
		const body = new Mesh(bodyGeometry, bodyMaterial);
		ghost.add(body);
		const eyeGeometry = new SphereGeometry(1, 32, 24);
		const eyeMaterial = new MeshPhysicalMaterial({
			color: "#101318",
			roughness: 0.22,
			clearcoat: 1,
		});
		const face = createGhostFace(body, eyeGeometry, eyeMaterial, eyeScale);
		face.group.visible = showEyes;
		ghost.add(face.group);
		face.update(expressionRef.current);
		const presentation = new Group();
		const decorations = createGhostDecorations(bodySurface.particleColors);
		presentation.add(ghost, decorations.group);
		presentation.rotation.x = 0.08;
		eyeMaterial.transparent = true;
		scene.add(presentation, new AmbientLight("#c5d2e5", 1.6));
		for (const [color, intensity, x, y, z] of [
			["#ffffff", 4, -15, 22, 25],
			["#c6dcff", 2, 20, 6, -12],
			["#fff2df", 1, -12, -10, 12],
		] as const) {
			const light = new DirectionalLight(color, intensity);
			light.position.set(x, y, z);
			scene.add(light);
		}
		let contextLost = false;
		let frame = 0;
		let visible = true;
		let dragging = false;
		let lastX = 0;
		let yaw = -0.25;
		let elapsed = 0;
		let lastTick = performance.now();
		let nextExpressionAt = 4;
		let expressionSelection = expressionRef.current;
		let animationSelection = animationRef.current;
		let animationStarted = 0;
		let expressionChangedAt = 0;
		let fromExpression = expressiveFrame(expressionSelection);
		let toExpression = fromExpression;
		const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
		const currentExpression = () =>
			blendExpressiveFrames(
				fromExpression,
				toExpression,
				(elapsed - expressionChangedAt) / 0.45
			);
		const draw = () => {
			if (contextLost) {
				return;
			}
			const moving = animated && !motion.matches;
			if (
				expressionSelection === "random" &&
				moving &&
				elapsed >= nextExpressionAt
			) {
				fromExpression = currentExpression();
				toExpression = expressiveFrame(randomExpressiveExpression());
				expressionChangedAt = elapsed;
				nextExpressionAt = elapsed + 4;
			}
			const expressionFrame = moving ? currentExpression() : toExpression;
			const animationTime = moving
				? elapsed - animationStarted
				: animationSelection === "random"
					? 0
					: expressiveAnimationPreviewTime(animationSelection);
			const sampled = sampleGhostAnimation(
				animationTime,
				animationSelection,
				expressionFrame,
				moving
			);
			face.updateFrame(sampled.eyes);
			bodySurface.update(moving ? elapsed : 0, animationDuration);
			eyeMaterial.opacity = sampled.eyeAlpha;
			decorations.update(sampled.decorations);
			presentation.rotation.y =
				yaw + (moving && !dragging ? Math.sin(elapsed / 2.4) * 0.16 : 0);
			ghost.position.set(
				sampled.body.x,
				-sampled.body.y +
					(moving && !dragging ? Math.sin(elapsed / 1.6) * 0.35 : 0),
				0
			);
			ghost.rotation.z =
				sampled.animation === "orbit"
					? -0.035 + Math.sin(animationTime * 1.4) * 0.08
					: -0.035 - (sampled.body.rotate * Math.PI) / 180;
			bodyMaterial.transparent = true;
			bodyMaterial.opacity =
				sampled.animation === "burst" || sampled.animation === "comet"
					? Math.min(1, Math.max(0, (sampled.body.scaleX - 0.27) / 0.3))
					: 1;
			bodyMaterial.depthWrite = bodyMaterial.opacity === 1;
			ghost.scale.set(
				sampled.body.scaleX,
				sampled.body.scaleY,
				Math.sqrt(sampled.body.scaleX * sampled.body.scaleY)
			);
			element.dataset.expression = toExpression.id;
			element.dataset.expressionProgress = (
				moving ? Math.min(1, (elapsed - expressionChangedAt) / 0.45) : 1
			).toFixed(3);
			element.dataset.animation = sampled.animation;
			element.dataset.eyeOpenness = sampled.eyes.eyes
				.map((eye) => eye.open.toFixed(3))
				.join(",");
			renderer.render(scene, camera);
		};
		const tick = (time: number) => {
			elapsed += Math.min(0.05, Math.max(0, (time - lastTick) / 1000));
			lastTick = time;
			draw();
			frame = requestAnimationFrame(tick);
		};
		const schedule = () => {
			cancelAnimationFrame(frame);
			lastTick = performance.now();
			draw();
			if (
				!contextLost &&
				animated &&
				!motion.matches &&
				visible &&
				!document.hidden
			) {
				frame = requestAnimationFrame(tick);
			}
		};
		updateFace.current = () => {
			if (expressionSelection !== expressionRef.current) {
				fromExpression = currentExpression();
				expressionSelection = expressionRef.current;
				toExpression = expressiveFrame(expressionSelection);
				expressionChangedAt = elapsed;
				nextExpressionAt = elapsed + 4;
			}
			if (animationSelection !== animationRef.current) {
				animationSelection = animationRef.current;
				animationStarted = elapsed;
			}
			schedule();
		};
		updateFace.current();
		const resize = new ResizeObserver(() => {
			const { width, height } = element.getBoundingClientRect();
			if (!(width && height)) {
				return;
			}
			renderer.setSize(width, height, false);
			camera.aspect = width / height;
			camera.updateProjectionMatrix();
			draw();
		});
		const observer = new IntersectionObserver(([entry]) => {
			visible = entry?.isIntersecting ?? false;
			schedule();
		});
		const down = (event: PointerEvent) => {
			if (!animated || event.button !== 0) {
				return;
			}
			dragging = true;
			lastX = event.clientX;
			canvas.setPointerCapture(event.pointerId);
		};
		const move = (event: PointerEvent) => {
			if (!dragging) {
				return;
			}
			yaw += (event.clientX - lastX) * 0.012;
			lastX = event.clientX;
			draw();
		};
		const keydown = (event: KeyboardEvent) => {
			if (
				!(animated && ["ArrowLeft", "ArrowRight", "Home"].includes(event.key))
			) {
				return;
			}
			event.preventDefault();
			yaw =
				event.key === "Home"
					? -0.25
					: yaw + (event.key === "ArrowLeft" ? -0.2 : 0.2);
			draw();
		};
		const up = () => {
			dragging = false;
			draw();
		};
		const lost = (event: Event) => {
			event.preventDefault();
			contextLost = true;
			cancelAnimationFrame(frame);
			canvas.style.display = "none";
			setReady(false);
		};
		canvas.addEventListener("keydown", keydown);
		canvas.addEventListener("pointerdown", down);
		canvas.addEventListener("pointermove", move);
		canvas.addEventListener("pointerup", up);
		canvas.addEventListener("pointercancel", up);
		canvas.addEventListener("webglcontextlost", lost);
		motion.addEventListener("change", schedule);
		document.addEventListener("visibilitychange", schedule);
		resize.observe(element);
		observer.observe(element);
		schedule();
		setReady(true);
		return () => {
			updateFace.current = null;
			cancelAnimationFrame(frame);
			resize.disconnect();
			observer.disconnect();
			motion.removeEventListener("change", schedule);
			document.removeEventListener("visibilitychange", schedule);
			canvas.removeEventListener("keydown", keydown);
			canvas.removeEventListener("pointerdown", down);
			canvas.removeEventListener("pointermove", move);
			canvas.removeEventListener("pointerup", up);
			canvas.removeEventListener("pointercancel", up);
			canvas.removeEventListener("webglcontextlost", lost);
			bodyGeometry.dispose();
			bodyMaterial.dispose();
			eyeGeometry.dispose();
			eyeMaterial.dispose();
			decorations.dispose();
			renderer.dispose();
			renderer.forceContextLoss();
			canvas.remove();
		};
	}, [
		animated,
		animationDuration,
		bodyStyle,
		colors?.bg,
		colors?.c1,
		colors?.c2,
		colors?.c3,
		eyeScale,
		showEyes,
	]);
	useEffect(() => {
		expressionRef.current = expression;
		animationRef.current = animation;
		updateFace.current?.();
	}, [expression, animation]);
	const logoContainerStyle: LogoContainerStyle = {
		"--logo-3d-1-width": drawingLength(size),
		"--logo-3d-1-height": drawingLength(size),
		"--logo-3d-1-position": "relative",
		"--logo-3d-1-cursor": animated ? "grab" : undefined,
	};
	const logoViewportStyle: LogoViewportStyle = {
		"--logo-3d-2-position": "absolute",
		"--logo-3d-2-inset": 0,
	};
	return (
		<div
			aria-label="Ryu 3D ghost"
			className={cn(className, drawingStyles.logoContainer)}
			data-logo-variant="3d"
			data-renderer={ready ? "webgl" : "fallback"}
			role="group"
			style={logoContainerStyle}
		>
			<div
				className={drawingStyles.logoViewport}
				ref={host}
				style={logoViewportStyle}
			/>
			{!ready && fallback}
		</div>
	);
}
