"use client";

// packages/ui/src/components/backdrop/backdrop.tsx
//
// `<Backdrop>` renders any registry entry (see definitions.ts) as a full-bleed
// layer. A static CSS poster is always painted underneath, so a lost WebGL
// context, a slow chunk or reduced motion leaves a finished-looking surface
// instead of a hole. Motion runs only when the caller opts in with `live` AND
// the viewer allows it: `prefers-reduced-motion` and Ryu's own
// `data-ryu-animations="off"` switch both force the still frame.

import { cn } from "@ryu/ui/lib/utils.ts";
import {
	Component,
	type ComponentType,
	type CSSProperties,
	type ReactNode,
	useEffect,
	useState,
} from "react";
import { z } from "zod";
import { DitherGradient } from "../dither-kit/gradient.tsx";
import { type DitherColor, PALETTE } from "../dither-kit/palette.ts";
import {
	AnimatedGradient,
	isAnimatedGradientPreset,
} from "../motion/animated-gradient.tsx";
import {
	type BackdropRendererProps,
	DottedGlobe,
	FlickeringGrid,
	FlowingLines,
	Meteors,
	ParticleField,
	ShootingStars,
	TopoField,
	TwinklingStars,
	WarpStarfield,
} from "./canvas-backdrops.tsx";
import {
	DotPattern,
	DriftingBlobs,
	FloatingShapes as FloatingPills,
	GridPattern,
	RadialGlow,
	RetroGrid,
	Ripple,
	Stripes,
} from "./css-backdrops.tsx";
import {
	type BackdropComponentId,
	type BackdropDefinition,
	backdropById,
	backdropPosterCss,
} from "./definitions.ts";
import { MarketplaceCssBackdrop } from "./marketplace-css-backdrop.tsx";
import type { PaperShaderId } from "./paper-defaults.ts";
import { type BackdropParams, resolveBackdropParams } from "./params.ts";

/** Cap the GL surface: a full-screen wallpaper at 3x DPR is millions of
 *  fragment-shader pixels per frame for decoration. */
const MAX_SHADER_PIXELS = 1600 * 900;

const shaderNumberSchema = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const animatedBackdropConfigSchema = z.object({
	color1: z.string().optional(),
	color2: z.string().optional(),
	color3: z.string().optional(),
	distortion: shaderNumberSchema.optional(),
	speed: shaderNumberSchema.optional(),
	swirl: shaderNumberSchema.optional(),
});
const ditherColorSchema = z.custom<DitherColor>(
	(value) =>
		z
			.string()
			.refine((color) => Object.hasOwn(PALETTE, color))
			.safeParse(value).success
);
const ditherBackdropSchema = z.object({
	background: z.string().optional(),
	direction: z.enum(["up", "down", "left", "right"]),
	from: ditherColorSchema,
	to: z.union([ditherColorSchema, z.literal("transparent")]),
});
interface BackdropPaintInputs extends CSSProperties {
	"--ryu-backdrop-paint"?: string;
}
function AnimatedGradientBackdrop({
	animate,
	className,
	params,
}: BackdropRendererProps) {
	const preset = isAnimatedGradientPreset(params.preset)
		? params.preset
		: "prism";
	const config = animatedBackdropConfigSchema.parse(params);
	return (
		<AnimatedGradient
			className={className ?? "absolute inset-0"}
			config={config}
			live={animate}
			preset={preset}
		/>
	);
}
function DitherBackdrop({ className, params }: BackdropRendererProps) {
	const paint = ditherBackdropSchema.parse(params);
	const style: BackdropPaintInputs = {
		"--ryu-backdrop-paint": paint.background,
	};
	return (
		<div
			aria-hidden="true"
			className={cn(
				className ?? "absolute inset-0",
				paint.background !== undefined && "ryu-backdrop-paint"
			)}
			style={style}
		>
			<DitherGradient
				className="absolute inset-0 size-full"
				direction={paint.direction}
				from={paint.from}
				to={paint.to}
			/>
		</div>
	);
}

const COMPONENTS = {
	"animated-gradient": AnimatedGradientBackdrop,
	dither: DitherBackdrop,
	"dotted-globe": DottedGlobe,
	dots: DotPattern,
	"drifting-blobs": DriftingBlobs,
	"flickering-grid": FlickeringGrid,
	"floating-shapes": FloatingPills,
	"flowing-lines": FlowingLines,
	grid: GridPattern,
	meteors: Meteors,
	particles: ParticleField,
	"radial-glow": RadialGlow,
	"retro-grid": RetroGrid,
	ripple: Ripple,
	"shooting-stars": ShootingStars,
	stripes: Stripes,
	"topo-field": TopoField,
	"twinkling-stars": TwinklingStars,
	"warp-starfield": WarpStarfield,
} satisfies Record<BackdropComponentId, ComponentType<BackdropRendererProps>>;

type PaperModule = typeof import("@paper-design/shaders-react");
let paperModule: Promise<PaperModule> | null = null;

function loadPaper(): Promise<PaperModule> {
	paperModule ??= import("@paper-design/shaders-react");
	return paperModule;
}

function paperRenderers(mod: PaperModule) {
	return {
		"color-panels": mod.ColorPanels,
		dithering: mod.Dithering,
		"dot-grid": mod.DotGrid,
		"dot-orbit": mod.DotOrbit,
		"gem-smoke": mod.GemSmoke,
		"god-rays": mod.GodRays,
		"grain-gradient": mod.GrainGradient,
		"liquid-metal": mod.LiquidMetal,
		"mesh-gradient": mod.MeshGradient,
		metaballs: mod.Metaballs,
		"neuro-noise": mod.NeuroNoise,
		"perlin-noise": mod.PerlinNoise,
		"pulsing-border": mod.PulsingBorder,
		"simplex-noise": mod.SimplexNoise,
		"smoke-ring": mod.SmokeRing,
		spiral: mod.Spiral,
		"static-mesh-gradient": mod.StaticMeshGradient,
		"static-radial-gradient": mod.StaticRadialGradient,
		swirl: mod.Swirl,
		voronoi: mod.Voronoi,
		warp: mod.Warp,
		water: mod.Water,
		waves: mod.Waves,
	};
}

function usePageVisible(): boolean {
	const [visible, setVisible] = useState(
		() => globalThis.document === undefined || !document.hidden
	);
	useEffect(() => {
		const sync = () => setVisible(!document.hidden);
		document.addEventListener("visibilitychange", sync);
		return () => document.removeEventListener("visibilitychange", sync);
	}, []);
	return visible;
}

function PaperBackdrop({
	animate,
	className,
	fixed,
	params,
	shader,
}: BackdropRendererProps & {
	fixed?: Extract<BackdropDefinition["render"], { kind: "paper" }>["fixed"];
	shader: PaperShaderId;
}) {
	const [mod, setMod] = useState<PaperModule | null>(null);
	const visible = usePageVisible();
	useEffect(() => {
		let cancelled = false;
		loadPaper()
			.then((loaded) => {
				if (!cancelled) {
					setMod(loaded);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);
	const Shader = mod ? paperRenderers(mod)[shader] : undefined;
	if (!Shader) {
		return null;
	}
	const parsedSpeed = shaderNumberSchema.safeParse(params.speed);
	const speed = parsedSpeed.success ? parsedSpeed.data : undefined;
	return (
		<Shader
			{...fixed}
			{...params}
			className={className ?? "absolute inset-0 size-full"}
			fit="cover"
			maxPixelCount={MAX_SHADER_PIXELS}
			speed={animate && visible ? speed : 0}
		/>
	);
}

// biome-ignore lint/style/useReactFunctionComponents: error boundaries must be class components
class BackdropBoundary extends Component<
	{ children: ReactNode; resetKey: string },
	{ failed: boolean; resetKey: string }
> {
	state = { failed: false, resetKey: this.props.resetKey };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	static getDerivedStateFromProps(
		props: { resetKey: string },
		state: { failed: boolean; resetKey: string }
	) {
		return props.resetKey === state.resetKey
			? null
			: { failed: false, resetKey: props.resetKey };
	}

	render() {
		return this.state.failed ? null : this.props.children;
	}
}

/** Motion allowed by the viewer: no reduced-motion, animations not turned off. */
export function useBackdropMotion(live: boolean): boolean {
	const [allowed, setAllowed] = useState(false);
	useEffect(() => {
		if (!live || globalThis.window === undefined) {
			setAllowed(false);
			return;
		}
		const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
		const root = document.documentElement;
		const sync = () =>
			setAllowed(
				!query?.matches && root.getAttribute("data-ryu-animations") !== "off"
			);
		sync();
		query?.addEventListener("change", sync);
		const observer = new MutationObserver(sync);
		observer.observe(root, {
			attributeFilter: ["data-ryu-animations"],
			attributes: true,
		});
		return () => {
			query?.removeEventListener("change", sync);
			observer.disconnect();
		};
	}, [live]);
	return allowed;
}

export interface BackdropProps {
	className?: string;
	/** A registry entry, or a definition supplied by the caller. */
	definition?: BackdropDefinition;
	id?: string;
	/** Opt in to motion. Grids and thumbnails should leave this off. */
	live?: boolean;
	/** Raw saved or contributed values are decoded before reaching a renderer. */
	params?: Parameters<typeof resolveBackdropParams>[1];
	/** Render only the static CSS poster (for thumbnails). */
	posterOnly?: boolean;
	/** Renders `custom` definitions; hosts provide a sandboxed renderer. */
	renderCustom?: (props: {
		animate: boolean;
		definition: BackdropDefinition;
		params: BackdropParams;
	}) => ReactNode;
}

export function Backdrop({
	className,
	definition: provided,
	id,
	live = false,
	params: rawParams,
	posterOnly = false,
	renderCustom,
}: BackdropProps) {
	const definition = provided ?? (id ? backdropById(id) : undefined);
	const params = resolveBackdropParams(definition?.params ?? [], rawParams);
	const animate = useBackdropMotion(live) && (definition?.animated ?? false);
	const poster = backdropPosterCss(params);
	const style: BackdropPaintInputs = { "--ryu-backdrop-paint": poster };

	let body: ReactNode = null;
	if (definition && (!posterOnly || definition.render.kind === "css")) {
		const { render } = definition;
		if (render.kind === "paper") {
			// Fixed paper shaders still need GL to draw their single frame, so a
			// still backdrop mounts the shader with speed 0 only when live.
			body = live ? (
				<PaperBackdrop
					animate={animate}
					fixed={render.fixed}
					params={params}
					shader={render.shader}
				/>
			) : null;
		} else if (render.kind === "component") {
			const Renderer = COMPONENTS[render.component];
			body = <Renderer animate={animate} params={params} />;
		} else if (render.kind === "css") {
			body = <MarketplaceCssBackdrop animate={animate} paint={render.style} />;
		} else {
			body = renderCustom?.({ animate, definition, params }) ?? null;
		}
	}

	return (
		<div
			aria-hidden="true"
			className={cn(
				"ryu-backdrop-paint pointer-events-none absolute inset-0 overflow-hidden",
				className
			)}
			data-backdrop-id={definition?.id}
			style={style}
		>
			<BackdropBoundary
				resetKey={`${definition?.id}:${JSON.stringify(params)}`}
			>
				{body}
			</BackdropBoundary>
		</div>
	);
}
