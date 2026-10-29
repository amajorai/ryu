"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import type { StageKey } from "./stage-routes.ts";
import { useBackdropGate } from "./use-backdrop-gate.ts";

/*
 * Animated stage backdrops for product heroes, one tuned preset per product.
 * Each effect loads on demand and only in the browser, so a page ships the code
 * for its own backdrop and nothing else. Every preset is drawn light on black
 * for the dark theme. In the light theme the layer is inverted with the hue
 * turned back half a turn, so the same effect reads as dark on white in its own
 * hues, and the stage follows the page's theme in both.
 *
 * Sources: React Bits and Spell UI components vendored under ./vendor (see
 * ./vendor/README.md); Starfield, RadiantLines and DesktopWindows are Ryu's
 * own.
 *
 * An effect mounts (and its chunk downloads) only after the first idle period,
 * and a WebGL effect only when the browser has a hardware GPU for it (see
 * ./webgl-gate.ts). Otherwise the plain stage and scrim around this layer are
 * the backdrop, as they are while an effect loads.
 */

const load = <P,>(loader: () => Promise<{ default: React.ComponentType<P> }>) =>
	dynamic(loader, { ssr: false });

const AnimatedGradient = load(
	() => import("./vendor/spell/animated-gradient.tsx")
);
const Antigravity = load(() => import("./vendor/react-bits/Antigravity.tsx"));
const Beams = load(() => import("./vendor/react-bits/Beams.tsx"));
const ColorBends = load(() => import("./vendor/react-bits/ColorBends.tsx"));
const DesktopWindows = load(() => import("./desktop-windows.tsx"));
const Dither = load(() => import("./vendor/react-bits/Dither.tsx"));
const Galaxy = load(() => import("./vendor/react-bits/Galaxy.tsx"));
const GradientWaves = load(
	() => import("./vendor/react-bits/GradientWaves.tsx")
);
const GridScan = load(() => import("./vendor/react-bits/GridScan.tsx"));
const LetterGlitch = load(() => import("./vendor/react-bits/LetterGlitch.tsx"));
const LightRays = load(() => import("./vendor/react-bits/LightRays.tsx"));
const MagnetLines = load(() => import("./vendor/react-bits/MagnetLines.tsx"));
const Particles = load(() => import("./vendor/react-bits/Particles.tsx"));
const PixelBlast = load(() => import("./vendor/react-bits/PixelBlast.tsx"));
const PixelSnow = load(() => import("./vendor/react-bits/PixelSnow.tsx"));
const Plasma = load(() => import("./vendor/react-bits/Plasma.tsx"));
const Prism = load(() => import("./vendor/react-bits/Prism.tsx"));
const RadiantLines = load(() => import("./radiant-lines.tsx"));
const SideRays = load(() => import("./vendor/react-bits/SideRays.tsx"));
const SpellRays = load(() => import("./vendor/spell/light-rays.tsx"));
const Starfield = load(() => import("./starfield.tsx"));
const Topography = load(() => import("./vendor/react-bits/Topography.tsx"));

const BRAND = "#0099ff";

/** Ryu's own 2D canvas backdrops: they need no WebGL, only an idle main thread. */
const CANVAS_2D_BACKDROPS: ReadonlySet<StageKey> = new Set([
	"bot",
	"connect",
	"desktop",
	"page-partners",
	"page-startups",
]);

// Stable prop objects: Spell UI rebuilds its shader program when `config` changes identity.
const MIST = { preset: "Mist" } as const;
const PULSE = { preset: "Pulse" } as const;
const PRISM = { preset: "Prism" } as const;
const LAVA = { preset: "Lava" } as const;
const AGENT_RAYS = { mode: "single", color: "#639AFF" } as const;
const PRO_RAYS = {
	mode: "multi",
	color1: "#639AFF",
	color2: "#9fd4ff",
} as const;

/** Product slug or page id → its backdrop. Each picks an effect whose motion echoes its subject. */
export const HERO_BACKGROUNDS = {
	// The runtime everything orbits.
	core: () => (
		<Galaxy
			density={1.1}
			glowIntensity={0.35}
			hueShift={200}
			saturation={0.4}
			transparent
		/>
	),
	// Beams of traffic routed through one line.
	gateway: () => <Beams color={BRAND} rotation={30} />,
	// One identity, many faces.
	passport: () => <Prism animationType="rotate" glow={1.6} scale={2.6} />,
	// One hub, many outgoing connections.
	connect: () => <RadiantLines color="#4fb3ff" />,
	// A soft managed layer overhead.
	cloud: () => <Plasma color="#4fa3ff" />,
	// A sealed box being scanned.
	box: () => <GridScan linesColor="#1b2a3a" scanColor={BRAND} />,
	// Signals going out.
	notify: () => <LightRays raysColor="#cfe9ff" raysOrigin="top-center" />,
	// The Oceanic waves palette of the 21st.dev "Adisyon" shader.
	mail: () => (
		<GradientWaves
			backgroundColor="#031C26"
			crestColor="#EAF9FF"
			horizonColor="#5AD2F4"
			waveColor="#1B6CA8"
		/>
	),
	// Messages as connected particles.
	messaging: () => (
		<Particles connections particleColors={["#ffffff", "#9fd4ff", BRAND]} />
	),
	// Colour and layout bending into a page.
	sites: () => (
		<ColorBends colors={["#0057d9", "#00c2ff", "#7a5cff"]} transparent />
	),
	"agents-as-a-service": () => <AnimatedGradient config={MIST} forceDark />,
	hire: () => <AnimatedGradient config={PULSE} forceDark />,
	// Capacity in blocks.
	compute: () => <PixelBlast color={BRAND} variant="square" />,
	share: () => <PixelSnow color="#cfe9ff" />,
	// Many parts pulled into one agent.
	agents: () => <Antigravity color="#9fd4ff" />,
	// Runs flowing over the terrain.
	workflows: () => <Topography color="#4fb3ff" />,
	skills: () => <AnimatedGradient config={PRISM} forceDark />,
	// Tools aligning to the agent.
	mcp: () => <MagnetLines accentColor={BRAND} lineColor="#3a4a5c" />,
	connections: () => <SideRays glow={1.8} intensity={3.4} />,
	// A terminal's glyphs.
	cli: () => <LetterGlitch glitchColors={["#0a3d62", BRAND, "#9fd4ff"]} />,
	sdk: () => <Dither palette={["#020814", "#0b3a8c", BRAND, "#cfe9ff"]} />,
	// Twinkling stars and the odd shooting star.
	bot: () => <Starfield />,
	agent: () => <SpellRays raysColor={AGENT_RAYS} />,
	os: () => <AnimatedGradient config={LAVA} forceDark />,
	// Windows on a desktop, focus passing between them.
	desktop: () => <DesktopWindows color="#4fb3ff" />,
	island: () => <Plasma color="#8b7bff" />,
	mobile: () => <GradientWaves />,
	"chrome-extension": () => (
		<ColorBends colors={["#1a73e8", "#34a853", "#fbbc04"]} transparent />
	),
	devices: () => (
		<Galaxy density={0.9} hueShift={30} saturation={0.3} transparent />
	),
	marketplace: () => <Prism animationType="hover" glow={1.2} scale={2.8} />,
	extensions: () => <MagnetLines accentColor="#7a5cff" lineColor="#3a3a52" />,
	// Probes sweeping for weak points.
	"red-team": () => <GridScan linesColor="#2a1414" scanColor="#ff4d4d" />,

	// Marketing pages.
	"page-platform": () => <Topography color={BRAND} />,
	"page-enterprise": () => <Beams color="#cfe9ff" rotation={-24} />,
	"page-pro": () => <SpellRays raysColor={PRO_RAYS} />,
	"page-teams": () => (
		<Particles connections particleColors={["#ffffff", "#9fd4ff"]} />
	),
	"page-startups": () => <Starfield color="#ffd29f" />,
	"page-students": () => <AnimatedGradient config={PRISM} forceDark />,
	"page-partners": () => <RadiantLines color="#9fd4ff" origin={[0.5, 1.15]} />,
	"page-security": () => <GridScan linesColor="#14202c" scanColor="#4fb3ff" />,
	"page-subscriptions": () => (
		<ColorBends colors={["#d97757", "#0099ff", "#10a37f"]} transparent />
	),
	"page-download": () => (
		<LightRays raysColor="#cfe9ff" raysOrigin="top-center" />
	),
	"page-products": () => (
		<Galaxy density={1.2} hueShift={210} saturation={0.5} transparent />
	),
	"page-for": () => <GradientWaves />,
	"page-compare": () => <SideRays glow={1.6} intensity={3} />,
	"page-creator": () => <AnimatedGradient config={PULSE} forceDark />,
	"page-community": () => (
		<Particles particleColors={["#ffffff", "#ffd29f", BRAND]} />
	),
	"page-perks": () => <PixelSnow color="#ffd29f" />,
	"page-academy": () => (
		<Dither palette={["#020814", "#1b2a6b", "#5a7bff", "#dfe6ff"]} />
	),
	"page-contact": () => <Plasma color="#4fa3ff" />,
	"page-apps": () => <PixelBlast color="#7a5cff" variant="circle" />,
} satisfies Record<StageKey, () => ReactNode>;

export type HeroBackgroundId = StageKey;

/** The backdrop layer: fills its positioned parent, behind the hero content. */
export function HeroBackground({ id }: { id: HeroBackgroundId }) {
	const gate = useBackdropGate(CANVAS_2D_BACKDROPS.has(id) ? null : "webgl2");
	return (
		<div
			aria-hidden="true"
			// Light theme: invert the light-on-black effect and turn its hue back,
			// so it draws dark on white in the same colours.
			className="absolute inset-0 z-0 overflow-hidden hue-rotate-180 invert dark:hue-rotate-0 dark:invert-0"
			data-backdrop={gate}
			data-hero-background={id}
		>
			{gate === "on" ? HERO_BACKGROUNDS[id]() : null}
		</div>
	);
}
