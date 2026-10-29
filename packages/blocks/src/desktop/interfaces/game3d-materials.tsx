/* eslint-disable react/no-unknown-property */
import type { ThreeElements } from "@react-three/fiber";
import {
	createContext,
	type ReactNode,
	type RefObject,
	useContext,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";
import type { Mesh, ShaderMaterial } from "three";
import { BACK_SIDE } from "./game3d-math.ts";
import type { Vec3 } from "./game3d-palette.ts";
import {
	curvePatch,
	hullGeometry,
	inkPatch,
	pointsPatch,
	toonPatch,
} from "./game3d-toon.ts";

/**
 * The 3D world's materials as JSX: every surface goes through one of these,
 * so it bends with the world and shares the cel-shaded look
 * (see game3d-toon.ts).
 */

type ToonProps = ThreeElements["meshToonMaterial"] & {
	/** Bends with the world (default); `false` for sky objects. */
	curve?: boolean;
	/** See-through when standing between the lens and the player. */
	fade?: boolean;
	/** Anime face shading: lit as if facing forward, soft warm shade. */
	face?: boolean;
	/** Fresnel rim light strength; characters use it, scenery does not. */
	rim?: number;
	/** Anime sheen band strength (hair). */
	sheen?: number;
	/** Wooden floorboards (the office floor). */
	planks?: boolean;
	/** Clapboard siding with a skirting board (cottage walls). */
	siding?: boolean;
};

/** Cel-shaded surface: two light bands, cool shade, optional rim light. */
export function ToonMaterial({
	curve = true,
	face = false,
	fade = false,
	planks = false,
	rim = 0,
	sheen = 0,
	siding = false,
	...props
}: ToonProps) {
	const patch = useMemo(
		() => toonPatch({ curve, face, fade, planks, rim, sheen, siding }),
		[curve, face, fade, planks, rim, sheen, siding]
	);
	return <meshToonMaterial {...patch} {...props} />;
}

/** Ink outline: back faces pushed out and drawn as a dark shade of `color`. */
export function InkMaterial({
	color,
	fade = false,
	width = 0.022,
}: {
	color?: string;
	fade?: boolean;
	width?: number;
}) {
	const patch = useMemo(() => inkPatch(width, fade), [fade, width]);
	return <meshBasicMaterial color={color} side={BACK_SIDE} {...patch} />;
}

/** Unlit surface that still bends with the world (glows, glass, rings). */
export function CurvedBasicMaterial(props: ThreeElements["meshBasicMaterial"]) {
	const patch = useMemo(() => curvePatch("basic"), []);
	return <meshBasicMaterial {...patch} {...props} />;
}

/**
 * Point sprites that bend with the world (pollen, fireflies, sparkles),
 * shrinking to a few pixels and fading out close to the lens.
 */
export function CurvedPointsMaterial(
	props: ThreeElements["pointsMaterial"] & { children?: ReactNode }
) {
	const patch = useMemo(() => pointsPatch(6), []);
	return <pointsMaterial {...patch} {...props} />;
}

/**
 * One cel-shaded mesh with an optional ink outline. The geometry is the
 * child; the outline is built from it once it exists.
 */
/**
 * Whether `ToonMesh` outlines are drawn in this subtree. Each outline is a
 * second draw call; on a software rasterizer the act layer's many small
 * props (pips, signs, alarms, marks) turn them off (`ActInk`).
 */
export const InkContext = createContext(true);

/** Draws `children` without ink outlines when `on` is false. */
export function ActInk({ children, on }: { children: ReactNode; on: boolean }) {
	return <InkContext.Provider value={on}>{children}</InkContext.Provider>;
}

export function ToonMesh({
	castShadow = false,
	children,
	color,
	face = false,
	ink = 0,
	position,
	receiveShadow = false,
	rim = 0,
	rotation,
	scale,
}: {
	castShadow?: boolean;
	children: ReactNode;
	color: string;
	/** Anime face shading (see `ToonOptions.face`). */
	face?: boolean;
	/** Outline width in world units; 0 for none. */
	ink?: number;
	position?: Vec3;
	receiveShadow?: boolean;
	rim?: number;
	rotation?: Vec3;
	scale?: Vec3 | number;
}) {
	const inked = useContext(InkContext);
	if (!inked) {
		ink = 0;
	}
	const main = useRef<Mesh>(null);
	const hull = useRef<Mesh>(null);
	useLayoutEffect(() => {
		if (!(ink > 0 && main.current && hull.current)) {
			return;
		}
		const geometry = hullGeometry(main.current.geometry);
		hull.current.geometry = geometry;
		return () => geometry.dispose();
	}, [ink]);
	return (
		<group position={position} rotation={rotation} scale={scale}>
			<mesh castShadow={castShadow} receiveShadow={receiveShadow} ref={main}>
				{children}
				<ToonMaterial color={color} face={face} rim={rim} />
			</mesh>
			{ink > 0 ? (
				<mesh ref={hull}>
					<InkMaterial color={color} width={ink} />
				</mesh>
			) : null}
		</group>
	);
}

/**
 * Makes a `<shaderMaterial>` use `uniforms` itself rather than the copy
 * React Three Fiber gives it, so per-frame updates (and uniform objects
 * shared across materials, like the world bend) reach the GPU.
 */
export function useBoundUniforms(
	material: RefObject<ShaderMaterial | null>,
	uniforms: ShaderMaterial["uniforms"]
): void {
	useLayoutEffect(() => {
		const shader = material.current;
		if (shader && shader.uniforms !== uniforms) {
			shader.uniforms = uniforms;
			shader.uniformsNeedUpdate = true;
		}
	});
}
