// packages/ui/src/components/backdrop/paper-defaults.ts
//
// GENERATED from @paper-design/shaders-react 0.0.78: each shader's first ("Default")
// preset with the sizing keys removed, plus the enum options its string params
// accept. Backdrop controls derive their sliders, colour pickers and selects
// from these values, so every paper shader is customizable without a
// hand-written schema. Regenerate when the package is upgraded.

import type {
	colorPanelsPresets,
	ditheringPresets,
	dotGridPresets,
	dotOrbitPresets,
	gemSmokePresets,
	godRaysPresets,
	grainGradientPresets,
	liquidMetalPresets,
	meshGradientPresets,
	metaballsPresets,
	neuroNoisePresets,
	PulsingBorderProps,
	perlinNoisePresets,
	pulsingBorderPresets,
	ShaderSizingParams,
	simplexNoisePresets,
	smokeRingPresets,
	spiralPresets,
	staticMeshGradientPresets,
	staticRadialGradientPresets,
	swirlPresets,
	voronoiPresets,
	warpPresets,
	waterPresets,
	wavesPresets,
} from "@paper-design/shaders-react";

// Full installed preset parameter owners, with exactly the same sizing/frame
// omissions as this generated control catalog. Readonly array cells preserve
// the existing readonly authored literals without changing any runtime value.
type ReadonlyPaperDefaultParameters<NativeParameters> = {
	readonly [Parameter in keyof NativeParameters]: Readonly<
		NativeParameters[Parameter]
	>;
};

interface NativePaperDefaultParameters {
	"color-panels": ReadonlyPaperDefaultParameters<
		Omit<
			(typeof colorPanelsPresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	dithering: ReadonlyPaperDefaultParameters<
		Omit<
			(typeof ditheringPresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	"dot-grid": ReadonlyPaperDefaultParameters<
		Omit<
			(typeof dotGridPresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	"dot-orbit": ReadonlyPaperDefaultParameters<
		Omit<
			(typeof dotOrbitPresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	"gem-smoke": ReadonlyPaperDefaultParameters<
		Omit<
			(typeof gemSmokePresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	"god-rays": ReadonlyPaperDefaultParameters<
		Omit<
			(typeof godRaysPresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	"grain-gradient": ReadonlyPaperDefaultParameters<
		Omit<
			(typeof grainGradientPresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	"liquid-metal": ReadonlyPaperDefaultParameters<
		Omit<
			(typeof liquidMetalPresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	"mesh-gradient": ReadonlyPaperDefaultParameters<
		Omit<
			(typeof meshGradientPresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	metaballs: ReadonlyPaperDefaultParameters<
		Omit<
			(typeof metaballsPresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	"neuro-noise": ReadonlyPaperDefaultParameters<
		Omit<
			(typeof neuroNoisePresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	"perlin-noise": ReadonlyPaperDefaultParameters<
		Omit<
			(typeof perlinNoisePresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	// The native component defaults an omitted aspectRatio to its Default preset.
	// Keep all other authored preset cells required; only this omitted native input
	// cell inherits the optional accepted PulsingBorderProps contract.
	"pulsing-border": ReadonlyPaperDefaultParameters<
		Omit<
			(typeof pulsingBorderPresets)[number]["params"],
			keyof ShaderSizingParams | "frame" | "aspectRatio"
		> &
			Pick<PulsingBorderProps, "aspectRatio">
	>;
	"simplex-noise": ReadonlyPaperDefaultParameters<
		Omit<
			(typeof simplexNoisePresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	"smoke-ring": ReadonlyPaperDefaultParameters<
		Omit<
			(typeof smokeRingPresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	spiral: ReadonlyPaperDefaultParameters<
		Omit<
			(typeof spiralPresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	"static-mesh-gradient": ReadonlyPaperDefaultParameters<
		Omit<
			(typeof staticMeshGradientPresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	"static-radial-gradient": ReadonlyPaperDefaultParameters<
		Omit<
			(typeof staticRadialGradientPresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	swirl: ReadonlyPaperDefaultParameters<
		Omit<
			(typeof swirlPresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	voronoi: ReadonlyPaperDefaultParameters<
		Omit<
			(typeof voronoiPresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	warp: ReadonlyPaperDefaultParameters<
		Omit<
			(typeof warpPresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	water: ReadonlyPaperDefaultParameters<
		Omit<
			(typeof waterPresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
	waves: ReadonlyPaperDefaultParameters<
		Omit<
			(typeof wavesPresets)[number]["params"],
			keyof ShaderSizingParams | "frame"
		>
	>;
}

type NativePaperDefaultCatalog = {
	[Shader in keyof NativePaperDefaultParameters]: {
		label: string;
		params: NativePaperDefaultParameters[Shader];
	};
};

export const PAPER_SHADER_DEFAULTS = {
	"color-panels": {
		label: "Color Panels",
		params: {
			speed: 0.5,
			colors: [
				"#ff9d00",
				"#fd4f30",
				"#809bff",
				"#6d2eff",
				"#333aff",
				"#f15cff",
				"#ffd557",
			],
			colorBack: "#000000",
			angle1: 0,
			angle2: 0,
			length: 1.1,
			edges: false,
			blur: 0,
			fadeIn: 1,
			fadeOut: 0.3,
			gradient: 0,
			density: 3,
		},
	},
	dithering: {
		label: "Dithering",
		params: {
			speed: 1,
			colorBack: "#000000",
			colorFront: "#00b2ff",
			shape: "sphere",
			type: "4x4",
			size: 2,
		},
	},
	"dot-grid": {
		label: "Dot Grid",
		params: {
			colorBack: "#000000",
			colorFill: "#ffffff",
			colorStroke: "#ffaa00",
			size: 2,
			gapX: 32,
			gapY: 32,
			strokeWidth: 0,
			sizeRange: 0,
			opacityRange: 0,
			shape: "circle",
		},
	},
	"dot-orbit": {
		label: "Dot Orbit",
		params: {
			speed: 1.5,
			colorBack: "#000000",
			colors: ["#ffc96b", "#ff6200", "#ff2f00", "#421100", "#1a0000"],
			size: 1,
			sizeRange: 0,
			spreading: 1,
			stepsPerColor: 4,
		},
	},
	"gem-smoke": {
		label: "Gem Smoke",
		params: {
			speed: 1,
			colorBack: "#f0efea",
			colorInner: "#fafaf5",
			colors: ["#333333", "#e7e6df"],
			outerGlow: 0.55,
			innerGlow: 1,
			innerDistortion: 0.8,
			outerDistortion: 0.6,
			offset: 0,
			angle: 0,
			size: 0.8,
			shape: "diamond",
		},
	},
	"god-rays": {
		label: "God Rays",
		params: {
			colorBack: "#000000",
			colorBloom: "#0000ff",
			colors: ["#a600ff6e", "#6200fff0", "#ffffff", "#33fff5"],
			density: 0.3,
			spotty: 0.3,
			midIntensity: 0.4,
			midSize: 0.2,
			intensity: 0.8,
			bloom: 0.4,
			speed: 0.75,
		},
	},
	"grain-gradient": {
		label: "Grain Gradient",
		params: {
			speed: 1,
			colorBack: "#000000",
			colors: ["#7300ff", "#eba8ff", "#00bfff", "#2a00ff"],
			softness: 0.5,
			intensity: 0.5,
			noise: 0.25,
			shape: "corners",
		},
	},
	"liquid-metal": {
		label: "Liquid Metal",
		params: {
			speed: 1,
			colorBack: "#AAAAAC",
			colorTint: "#ffffff",
			distortion: 0.07,
			repetition: 2,
			shiftRed: 0.3,
			shiftBlue: 0.3,
			contour: 0.4,
			softness: 0.1,
			angle: 70,
			shape: "diamond",
		},
	},
	"mesh-gradient": {
		label: "Mesh Gradient",
		params: {
			speed: 1,
			colors: ["#e0eaff", "#241d9a", "#f75092", "#9f50d3"],
			distortion: 0.8,
			swirl: 0.1,
			grainMixer: 0,
			grainOverlay: 0,
		},
	},
	metaballs: {
		label: "Metaballs",
		params: {
			speed: 1,
			colorBack: "#000000",
			colors: ["#6e33cc", "#ff5500", "#ffc105", "#ffc800", "#f585ff"],
			count: 10,
			size: 0.83,
		},
	},
	"neuro-noise": {
		label: "Neuro Noise",
		params: {
			speed: 1,
			colorFront: "#ffffff",
			colorMid: "#47a6ff",
			colorBack: "#000000",
			brightness: 0.05,
			contrast: 0.3,
		},
	},
	"perlin-noise": {
		label: "Perlin Noise",
		params: {
			speed: 0.5,
			colorBack: "#632ad5",
			colorFront: "#fccff7",
			proportion: 0.35,
			softness: 0.1,
			octaveCount: 1,
			persistence: 1,
			lacunarity: 1.5,
		},
	},
	"pulsing-border": {
		label: "Pulsing Border",
		params: {
			speed: 1,
			colorBack: "#000000",
			colors: ["#0dc1fd", "#d915ef", "#ff3f2ecc"],
			roundness: 0.25,
			thickness: 0.1,
			margin: 0,
			marginLeft: 0,
			marginRight: 0,
			marginTop: 0,
			marginBottom: 0,
			softness: 0.75,
			intensity: 0.2,
			bloom: 0.25,
			spots: 5,
			spotSize: 0.5,
			pulse: 0.25,
			smoke: 0.3,
			smokeSize: 0.6,
		},
	},
	"simplex-noise": {
		label: "Simplex Noise",
		params: {
			speed: 0.5,
			colors: ["#4449CF", "#FFD1E0", "#F94446", "#FFD36B", "#FFFFFF"],
			stepsPerColor: 2,
			softness: 0,
		},
	},
	"smoke-ring": {
		label: "Smoke Ring",
		params: {
			speed: 0.5,
			colorBack: "#000000",
			colors: ["#ffffff"],
			noiseScale: 3,
			noiseIterations: 8,
			radius: 0.25,
			thickness: 0.65,
			innerShape: 0.7,
		},
	},
	spiral: {
		label: "Spiral",
		params: {
			colorBack: "#001429",
			colorFront: "#79D1FF",
			density: 1,
			distortion: 0,
			strokeWidth: 0.5,
			strokeTaper: 0,
			strokeCap: 0,
			noise: 0,
			noiseFrequency: 0,
			softness: 0,
			speed: 1,
		},
	},
	"static-mesh-gradient": {
		label: "Static Mesh Gradient",
		params: {
			speed: 0,
			colors: ["#ffad0a", "#6200ff", "#e2a3ff", "#ff99fd"],
			positions: 2,
			waveX: 1,
			waveXShift: 0.6,
			waveY: 1,
			waveYShift: 0.21,
			mixing: 0.93,
			grainMixer: 0,
			grainOverlay: 0,
		},
	},
	"static-radial-gradient": {
		label: "Static Radial Gradient",
		params: {
			speed: 0,
			colorBack: "#000000",
			colors: ["#00bbff", "#00ffe1", "#ffffff"],
			radius: 0.8,
			focalDistance: 0.99,
			focalAngle: 0,
			falloff: 0.24,
			mixing: 0.5,
			distortion: 0,
			distortionShift: 0,
			distortionFreq: 12,
			grainMixer: 0,
			grainOverlay: 0,
		},
	},
	swirl: {
		label: "Swirl",
		params: {
			speed: 0.32,
			colorBack: "#330000",
			colors: ["#ffd1d1", "#ff8a8a", "#660000"],
			bandCount: 4,
			twist: 0.1,
			center: 0.2,
			proportion: 0.5,
			softness: 0,
			noiseFrequency: 0.4,
			noise: 0.2,
		},
	},
	voronoi: {
		label: "Voronoi",
		params: {
			speed: 0.5,
			colors: ["#ff8247", "#ffe53d"],
			stepsPerColor: 3,
			colorGlow: "#ffffff",
			colorGap: "#2e0000",
			distortion: 0.4,
			gap: 0.04,
			glow: 0,
		},
	},
	warp: {
		label: "Warp",
		params: {
			speed: 1,
			colors: ["#121212", "#9470ff", "#121212", "#8838ff"],
			proportion: 0.45,
			softness: 1,
			distortion: 0.25,
			swirl: 0.8,
			swirlIterations: 10,
			shapeScale: 0.1,
			shape: "checks",
		},
	},
	water: {
		label: "Water",
		params: {
			speed: 1,
			colorBack: "#909090",
			colorHighlight: "#ffffff",
			highlights: 0.07,
			layering: 0.5,
			edges: 0.8,
			waves: 0.3,
			caustic: 0.1,
			size: 1,
		},
	},
	waves: {
		label: "Waves",
		params: {
			colorFront: "#ffbb00",
			colorBack: "#000000",
			shape: 0,
			frequency: 0.5,
			amplitude: 0.5,
			spacing: 1.2,
			proportion: 0.1,
			softness: 0,
		},
	},
} as const satisfies NativePaperDefaultCatalog;

export type PaperShaderId = keyof typeof PAPER_SHADER_DEFAULTS;

/** Allowed values for enum-like string params, keyed `<shader>.<param>`. */
export const PAPER_SHADER_OPTIONS = {
	"dithering.shape": [
		"simplex",
		"warp",
		"dots",
		"wave",
		"ripple",
		"swirl",
		"sphere",
	],
	"dithering.type": ["random", "2x2", "4x4", "8x8"],
	"dot-grid.shape": ["circle", "diamond", "square", "triangle"],
	"gem-smoke.shape": ["none", "circle", "daisy", "diamond", "metaballs"],
	"grain-gradient.shape": [
		"wave",
		"dots",
		"truchet",
		"corners",
		"ripple",
		"blob",
		"sphere",
	],
	"liquid-metal.shape": ["none", "circle", "daisy", "diamond", "metaballs"],
	"warp.shape": ["checks", "stripes", "edge"],
};
