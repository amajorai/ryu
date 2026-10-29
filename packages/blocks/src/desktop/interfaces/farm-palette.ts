/**
 * Farm art: grass, soil, timber, the barn, crops and farmer colors the farm
 * is painted with. Game art is allowed its own palette (this is the one file
 * in the Farm where literal colors live); chrome never uses these and takes
 * the theme's semantic tokens instead.
 *
 * The palette is a stylesheet of custom properties scoped to the scene, so
 * the art follows the theme without reading it in JavaScript: light themes
 * get a sunny afternoon, dark themes (`.dark`) the same farm by moonlight,
 * with its ground and timber repainted in night colors while fruit and
 * lights keep their day values. By day each color is tinted a little toward
 * the theme's primary so the farm belongs to whichever theme is active.
 */

/** How many shirt, skin and fruit-accent variants the art has. */
export const FARM_SWATCHES = {
	hat: 3,
	overall: 3,
	shirt: 6,
	skin: 4,
} as const;

type Mood = Record<string, string>;

const DAY: Mood = {
	apple: "#e0473c",
	"apple-light": "#f27a62",
	barn: "#c4523f",
	"barn-dark": "#9a3b2f",
	"barn-door": "#7d2f26",
	"barn-roof": "#6b5a54",
	"barn-roof-dark": "#544540",
	"barn-trim": "#fbf3e4",
	blight: "#6e4a3a",
	blossom: "#ffffff",
	blueberry: "#4f63b8",
	"blueberry-light": "#7d8fda",
	droplet: "#4aa8e0",
	"droplet-light": "#bfe6fb",
	duck: "#fbf7ee",
	"duck-beak": "#f0a234",
	fence: "#d9b88c",
	"figure-edge": "#3a2a20",
	"fence-dark": "#a9845a",
	firefly: "#fff3a6",
	"flower-a": "#ffffff",
	"flower-b": "#f6d55c",
	"flower-c": "#f19bb0",
	gauge: "#c5f06a",
	"gauge-track": "#7a4d2e",
	glow: "#ffd95e",
	grape: "#7d4f9e",
	"grape-light": "#a678c4",
	grass: "#9ccc6a",
	"grass-dark": "#86b957",
	"grass-light": "#b3da82",
	hay: "#ecc65e",
	"hay-dark": "#c99c37",
	hat: "#e8c675",
	"hat-band": "#a0522d",
	ink: "#3a2a20",
	leaf: "#4f9a43",
	"leaf-dark": "#3b7d34",
	"leaf-light": "#78b95a",
	lantern: "#ffcf6b",
	lily: "#5fa25a",
	moon: "#f3f0dc",
	"overall-0": "#4a6fa5",
	"overall-1": "#5c8a4e",
	"overall-2": "#8a6248",
	"overall-dark-0": "#3a5683",
	"overall-dark-1": "#466c3b",
	"overall-dark-2": "#6b4a36",
	path: "#e3cc9a",
	"path-edge": "#cdb17b",
	"path-stone": "#d2b985",
	pumpkin: "#ee8a2c",
	"pumpkin-light": "#f6ab55",
	ring: "#ffffff",
	"ring-track": "#1d2a14",
	shade: "#1f2a12",
	"shirt-0": "#e06c5a",
	"shirt-1": "#5f93cf",
	"shirt-2": "#e2b13f",
	"shirt-3": "#8a6cc2",
	"shirt-4": "#4fa596",
	"shirt-5": "#e58bb0",
	sign: "#c9925a",
	"sign-dark": "#8e5f33",
	"sign-ink": "#3b2614",
	"sign-light": "#e0b07a",
	silo: "#c9d0d6",
	"silo-dark": "#a4adb5",
	"silo-roof": "#8b949c",
	"skin-0": "#f3cba8",
	"skin-1": "#dca47d",
	"skin-2": "#ac7450",
	"skin-3": "#7b4f34",
	crack: "#8c6a48",
	drip: "#5d7d8c",
	mulch: "#ecd08a",
	plank: "#b98a5c",
	"plank-dark": "#8b6440",
	"plank-light": "#d6a974",
	soil: "#a8744a",
	"soil-dark": "#8a5a36",
	"soil-dry": "#cdb08a",
	"soil-dry-dark": "#ae8f68",
	"soil-dry-light": "#dcc39f",
	"soil-face": "#77492b",
	"soil-light": "#bd8a5c",
	"soil-rich": "#7d4f30",
	"soil-rich-dark": "#5f3a21",
	"soil-rich-light": "#946140",
	"soil-tilled": "#b98458",
	"soil-tilled-light": "#cf9d70",
	sparkle: "#fff3b0",
	"sparkle-edge": "#c98a12",
	stem: "#5b8a3a",
	strawberry: "#e2384d",
	"strawberry-seed": "#f9e3a0",
	tag: "#f7ecd2",
	"tag-edge": "#b08a5c",
	"tag-ink": "#c23a2b",
	tomato: "#e8502f",
	"tomato-light": "#f47c55",
	trunk: "#8a5a3c",
	"trunk-dark": "#6b4430",
	water: "#7cc4e4",
	"water-dark": "#5aa7cc",
	"water-light": "#c8ecf8",
	window: "#fbe7b0",
	wither: "#7a6a4f",
	"wither-dark": "#5f5240",
	"wither-edge": "#3a2c1f",
	"wither-fruit": "#6e4a3c",
};

/**
 * The moonlit farm, painted directly: ground, timber and buildings in their
 * own night colors (no overlay), so fruit stays saturated on top of them.
 */
const NIGHT: Mood = {
	barn: "#93402f",
	"barn-dark": "#6c2c22",
	"barn-door": "#4f2019",
	"barn-roof": "#3f3a44",
	"barn-roof-dark": "#312d36",
	"barn-trim": "#d9d0c0",
	blight: "#3a2a22",
	blossom: "#e4e6f0",
	fence: "#8c7458",
	"figure-edge": "#b3a991",
	"fence-dark": "#5e4b37",
	"flower-a": "#c9ccd8",
	"flower-b": "#c2a94c",
	"flower-c": "#b07a92",
	"gauge-track": "#2e1f15",
	grass: "#24432f",
	"grass-dark": "#1d3826",
	"grass-light": "#2c5038",
	hat: "#b49a62",
	hay: "#a98c47",
	"hay-dark": "#7d6733",
	ink: "#1e1610",
	leaf: "#2f7a3e",
	"leaf-dark": "#215c2e",
	"leaf-light": "#3f9150",
	path: "#5d5240",
	"path-edge": "#483f31",
	"path-stone": "#6c604c",
	sign: "#7d5434",
	"sign-dark": "#4f331d",
	"sign-ink": "#f6ead4",
	"sign-light": "#a37650",
	silo: "#7d8794",
	"silo-dark": "#626b77",
	"silo-roof": "#545c66",
	crack: "#4a3a2a",
	plank: "#6a4e36",
	"plank-dark": "#4a3524",
	"plank-light": "#8a6748",
	soil: "#674833",
	"soil-dark": "#47301f",
	"soil-dry": "#7d6a52",
	"soil-dry-dark": "#64543f",
	"soil-dry-light": "#8d7a60",
	"soil-face": "#33231a",
	"soil-light": "#83603f",
	"soil-rich": "#4f3220",
	"soil-rich-dark": "#3a2416",
	"soil-rich-light": "#5f3f29",
	"soil-tilled": "#72513a",
	"soil-tilled-light": "#86634a",
	stem: "#3d6e2e",
	trunk: "#5a3e2a",
	"trunk-dark": "#3e2a1c",
	wither: "#5e5442",
	"wither-dark": "#4a4235",
	"wither-edge": "#17110b",
	"wither-fruit": "#56403a",
};

/** Characters and other art not repainted for night are dimmed toward this. */
const DUSK = "#141a26";

/**
 * Farmers' clothes and skin are dimmed less than the scenery at night, so
 * the figures still stand out from the grass they work in.
 */
const CHARACTER = /^(hat|overall|shirt|skin)/;

/** Colors that keep their day value at night: fruit, lights, labels. */
const LIT = new Set([
	"apple",
	"apple-light",
	"blueberry",
	"blueberry-light",
	"droplet",
	"droplet-light",
	"firefly",
	"gauge",
	"glow",
	"grape",
	"grape-light",
	"lantern",
	"moon",
	"pumpkin",
	"pumpkin-light",
	"ring",
	"shade",
	"sparkle",
	"sparkle-edge",
	"strawberry",
	"strawberry-seed",
	"tag",
	"tag-edge",
	"tag-ink",
	"tomato",
	"tomato-light",
	"window",
]);

function declarations(night: boolean): string {
	const lines: string[] = [];
	for (const [name, value] of Object.entries(DAY)) {
		let color = `color-mix(in oklab, ${value} 94%, var(--primary))`;
		if (night) {
			const painted = NIGHT[name];
			if (painted) {
				color = painted;
			} else if (LIT.has(name)) {
				color = value;
			} else if (CHARACTER.test(name)) {
				color = `color-mix(in oklab, ${value} 86%, ${DUSK})`;
			} else {
				color = `color-mix(in oklab, ${value} 72%, ${DUSK})`;
			}
		}
		lines.push(`--fm-${name}: ${color};`);
	}
	return lines.join("\n");
}

const SCOPE = "[data-farm-scene]";

/**
 * The scene stylesheet: both moods as custom properties, plus the keyframes
 * the art uses. Motion is dropped when the viewer prefers reduced motion
 * (either the media query or `data-motion="reduce"` from the root).
 */
export const FARM_SCENE_CSS = `
${SCOPE} {
${declarations(false)}
--fm-night: 0;
--fm-figure-edge: 0;
}
.dark ${SCOPE}, ${SCOPE}.dark {
${declarations(true)}
--fm-night: 1;
--fm-figure-edge: 0.9px;
}
@keyframes fm-sway { 0%, 100% { transform: rotate(-2.5deg); } 50% { transform: rotate(2.5deg); } }
@keyframes fm-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-1.5px); } }
@keyframes fm-spin { to { transform: rotate(360deg); } }
@keyframes fm-orbit { to { stroke-dashoffset: -100; } }
@keyframes fm-twinkle { 0%, 100% { opacity: 0.2; transform: scale(0.6); } 50% { opacity: 1; transform: scale(1); } }
@keyframes fm-drip { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
@keyframes fm-firefly { 0%, 100% { opacity: 0; transform: translate(0, 0); } 30% { opacity: 1; } 50% { transform: translate(6px, -8px); } 70% { opacity: 0.9; } }
${SCOPE} .fm-sway { transform-box: fill-box; transform-origin: 50% 100%; animation: fm-sway 3.2s ease-in-out infinite; }
${SCOPE} .fm-bob { animation: fm-bob 1.6s ease-in-out infinite; }
${SCOPE} .fm-spin { transform-box: fill-box; transform-origin: 50% 50%; animation: fm-spin 1.6s linear infinite; }
${SCOPE} .fm-orbit { animation: fm-orbit 2.4s linear infinite; }
${SCOPE} .fm-twinkle { transform-box: fill-box; transform-origin: 50% 50%; animation: fm-twinkle 2.2s ease-in-out infinite; }
${SCOPE} .fm-drip { animation: fm-drip 2s ease-in-out infinite; }
${SCOPE} .fm-firefly { animation: fm-firefly 5s ease-in-out infinite; }
${SCOPE}[data-motion="reduce"] .fm-sway, ${SCOPE}[data-motion="reduce"] .fm-bob, ${SCOPE}[data-motion="reduce"] .fm-spin, ${SCOPE}[data-motion="reduce"] .fm-twinkle, ${SCOPE}[data-motion="reduce"] .fm-drip, ${SCOPE}[data-motion="reduce"] .fm-orbit { animation: none; }
${SCOPE}[data-motion="reduce"] .fm-firefly { display: none; }
@media (prefers-reduced-motion: reduce) {
${SCOPE} .fm-sway, ${SCOPE} .fm-bob, ${SCOPE} .fm-spin, ${SCOPE} .fm-twinkle, ${SCOPE} .fm-drip, ${SCOPE} .fm-orbit { animation: none; }
${SCOPE} .fm-firefly { display: none; }
}
`;

/** A palette color by name, as a CSS value the art can fill with. */
export function fm(name: string): string {
	return `var(--fm-${name})`;
}

/**
 * The 3D diorama's farm colours (soil, beds, barn, crops), on top of the
 * game kit's shared scene palette (`game3d-palette.ts`). Night dims the
 * timber and soil; fruit keeps its colour.
 */
export const FARM_3D = {
	barnDoor: "#fbf3e4",
	barnRoof: "#7a5f56",
	barnRoofNight: "#4f4048",
	barnTrim: "#fbf3e4",
	barnWall: "#d0543f",
	barnWallNight: "#8f4440",
	bedFrame: "#b98552",
	bedFrameNight: "#7b5a44",
	droplet: "#6cc4f0",
	hay: "#f2cf6b",
	hayBand: "#c99a3a",
	leaf: "#5cb848",
	leafDark: "#3f9a3e",
	leafYoung: "#9fdc6a",
	path: "#e7cf9f",
	pathNight: "#8d8394",
	ridge: "#8a5a3c",
	silo: "#e8e2d6",
	siloRoof: "#8fa3b8",
	soil: "#a46a45",
	soilDry: "#c4a079",
	soilNight: "#6d4c44",
	stake: "#c49a63",
	stem: "#4f9a46",
	window: "#a9d3e3",
	windowLit: "#ffd36e",
	withered: "#a1825c",
	witheredDark: "#7c6146",
	/** The act layer's set pieces: the porch, mailbox and gate at the you-spot. */
	porchDeck: "#c89564",
	porchPost: "#f4ead8",
	porchRoof: "#8a5a3c",
	mailbox: "#4f7fb8",
	mailboxFlag: "#e8453c",
	gate: "#f4ead8",
	/** The sundial by the benches (a limited farmer waits there). */
	sundial: "#cfc6b6",
	gnomon: "#6f655a",
	/** The scarecrow on a withered bed: straw, coat, hat, red lantern, crow. */
	scarecrowCoat: "#6b8fb8",
	scarecrowHat: "#c9a25a",
	straw: "#f2cf6b",
	lantern: "#e8453c",
	crow: "#2a2630",
} as const;

/** The plan's pips as crops: leaves grown, soil to go, a pale guess. */
export const FARM_PIP_SKIN = {
	done: FARM_3D.leaf,
	estimate: FARM_3D.leafYoung,
	todo: FARM_3D.soil,
} as const;

/** The hourglass stands on a fence post. */
export const FARM_TIMER_SKIN = { color: FARM_3D.stake } as const;

/** Fruit colours on the 3D plants: main and highlight. */
export const FRUIT_3D = {
	apple: ["#e8453c", "#ff8a6a"],
	blueberry: ["#5b6fd0", "#8a9cf0"],
	grapes: ["#8c5bc4", "#b48ae6"],
	pumpkin: ["#f0912e", "#ffb45c"],
	strawberry: ["#e8384a", "#ff7a86"],
	tomato: ["#e8453c", "#ff7a62"],
} as const;
