import { z } from "zod";
import { observeNativeOptionalProperty } from "../lib/native-optional-property.mjs";
import {
	isNativeObjectLike,
	isNativeText,
} from "../lib/native-primitive-observation.ts";
import {
	type ContributedPartId,
	GHOST_AVATAR_REGIONS,
	isContributedPartId,
} from "./avatar-parts.ts";

/* Costumes for the Ryu ghost avatar: colour, finish, face (eyes, brows,
   mouth), ears, headwear, glasses, an accessory, and a pattern, plus
   whole-outfit presets. Stored on a ghost avatar as `costume` (see
   ghost-avatar.ts) and drawn by ghost-costume-art.tsx. Region slots may also
   hold a marketplace accessory id (`<plugin-id>:<local-id>`, see
   avatar-parts.ts); colour and finish stay built-in. */

export const COSTUME_PALETTES = {
	purple: {
		label: "Witchlight",
		base: "#c9a8ff",
		light: "#f1e6ff",
		deep: "#7d4fd6",
	},
	green: { label: "Slime", base: "#b8f08a", light: "#ecffdc", deep: "#5aa62c" },
	orange: {
		label: "Pumpkin",
		base: "#ffb877",
		light: "#ffe9d2",
		deep: "#e2661b",
	},
	blue: {
		label: "Moonbeam",
		base: "#a9dcff",
		light: "#e8f7ff",
		deep: "#3f8fd1",
	},
	bone: { label: "Bone", base: "#f2e8d5", light: "#fffbf2", deep: "#b9a98a" },
	pink: { label: "Candy", base: "#ffb3d9", light: "#ffe8f4", deep: "#d9488f" },
	blood: {
		label: "Blood moon",
		base: "#ff8a7a",
		light: "#ffe0da",
		deep: "#c2342a",
	},
	midnight: {
		label: "Midnight",
		base: "#4b3d7a",
		light: "#9a8ad8",
		deep: "#1d1438",
	},
} as const;

export type CostumePaletteId = keyof typeof COSTUME_PALETTES;

export const COSTUME_FINISHES = {
	smooth: "Smooth",
	gradient: "Gradient",
	plastic: "Plastic",
	fabric: "Sheet fabric",
	"3d": "3D",
	glow: "Ectoplasm",
	glass: "Glass",
	holo: "Holographic",
} as const;

export const COSTUME_EYES = {
	classic: "Classic",
	happy: "Happy",
	sleepy: "Sleepy",
	star: "Starry",
	heart: "Smitten",
	x: "Spooked",
	spiral: "Hypnotised",
	glow: "Glowing",
} as const;

export const COSTUME_BROWS = {
	none: "None",
	raised: "Raised",
	angry: "Wicked",
	worried: "Worried",
	unibrow: "Unibrow",
	bushy: "Bushy",
} as const;

export const COSTUME_MOUTHS = {
	none: "None",
	smile: "Smile",
	fangs: "Fangs",
	grin: "Lantern grin",
	o: "Boo!",
	tongue: "Cheeky",
	stitched: "Stitched",
} as const;

export const COSTUME_EARS = {
	none: "None",
	cat: "Cat ears",
	bat: "Bat ears",
	bunny: "Bunny ears",
	horns: "Devil horns",
	bolts: "Neck bolts",
} as const;

export const COSTUME_HEADWEAR = {
	none: "None",
	witch: "Witch hat",
	pumpkin: "Pumpkin cap",
	crown: "Crown",
	tophat: "Top hat",
	halo: "Halo",
	party: "Party hat",
} as const;

export const COSTUME_GLASSES = {
	none: "None",
	round: "Round",
	star: "Star",
	heart: "Heart",
	monocle: "Monocle",
	patch: "Eye patch",
	threeD: "3D glasses",
	shades: "Shades",
} as const;

export const COSTUME_ACCESSORIES = {
	none: "None",
	bowtie: "Bow tie",
	cape: "Vampire cape",
	scarf: "Scarf",
	bucket: "Candy bucket",
	wand: "Wand",
	lantern: "Lantern",
} as const;

export const COSTUME_PATTERNS = {
	none: "None",
	mummy: "Mummy wraps",
	skeleton: "Skeleton",
	stitches: "Stitches",
	stripes: "Stripes",
	polka: "Polka dots",
	web: "Cobweb",
} as const;

export interface GhostCostume {
	accessory: keyof typeof COSTUME_ACCESSORIES | ContributedPartId;
	brows: keyof typeof COSTUME_BROWS | ContributedPartId;
	ears: keyof typeof COSTUME_EARS | ContributedPartId;
	eyes: keyof typeof COSTUME_EYES | ContributedPartId;
	finish: keyof typeof COSTUME_FINISHES;
	glasses: keyof typeof COSTUME_GLASSES | ContributedPartId;
	headwear: keyof typeof COSTUME_HEADWEAR | ContributedPartId;
	mouth: keyof typeof COSTUME_MOUTHS | ContributedPartId;
	palette: CostumePaletteId;
	pattern: keyof typeof COSTUME_PATTERNS | ContributedPartId;
}

export const PLAIN_COSTUME: GhostCostume = {
	palette: "bone",
	finish: "3d",
	eyes: "classic",
	brows: "none",
	mouth: "none",
	ears: "none",
	headwear: "none",
	glasses: "none",
	accessory: "none",
	pattern: "none",
};

/** Whole-outfit presets. Each sets every slot so switching is predictable. */
export const GHOST_COSTUME_PRESETS: {
	id: string;
	label: string;
	costume: GhostCostume;
}[] = [
	{
		id: "pumpkin",
		label: "Pumpkin king",
		costume: {
			...PLAIN_COSTUME,
			palette: "orange",
			finish: "3d",
			mouth: "grin",
			headwear: "pumpkin",
			accessory: "bucket",
		},
	},
	{
		id: "witch",
		label: "Witch",
		costume: {
			...PLAIN_COSTUME,
			palette: "green",
			finish: "fabric",
			eyes: "happy",
			brows: "raised",
			mouth: "smile",
			headwear: "witch",
			accessory: "wand",
		},
	},
	{
		id: "vampire",
		label: "Vampire",
		costume: {
			...PLAIN_COSTUME,
			palette: "bone",
			finish: "plastic",
			eyes: "glow",
			brows: "angry",
			mouth: "fangs",
			accessory: "cape",
		},
	},
	{
		id: "mummy",
		label: "Mummy",
		costume: {
			...PLAIN_COSTUME,
			palette: "bone",
			finish: "fabric",
			eyes: "glow",
			pattern: "mummy",
		},
	},
	{
		id: "devil",
		label: "Little devil",
		costume: {
			...PLAIN_COSTUME,
			palette: "blood",
			finish: "gradient",
			brows: "angry",
			mouth: "fangs",
			ears: "horns",
			accessory: "lantern",
		},
	},
	{
		id: "skeleton",
		label: "Skeleton",
		costume: {
			...PLAIN_COSTUME,
			palette: "midnight",
			finish: "smooth",
			eyes: "glow",
			mouth: "stitched",
			pattern: "skeleton",
		},
	},
	{
		id: "frankenstein",
		label: "Frankenghost",
		costume: {
			...PLAIN_COSTUME,
			palette: "green",
			finish: "smooth",
			brows: "unibrow",
			mouth: "stitched",
			ears: "bolts",
			pattern: "stitches",
		},
	},
	{
		id: "cat",
		label: "Black cat",
		costume: {
			...PLAIN_COSTUME,
			palette: "midnight",
			finish: "plastic",
			eyes: "glow",
			mouth: "o",
			ears: "cat",
			accessory: "bowtie",
		},
	},
	{
		id: "bat",
		label: "Bat",
		costume: {
			...PLAIN_COSTUME,
			palette: "purple",
			finish: "glow",
			eyes: "classic",
			mouth: "fangs",
			ears: "bat",
		},
	},
	{
		id: "fairy",
		label: "Sugar spirit",
		costume: {
			...PLAIN_COSTUME,
			palette: "pink",
			finish: "holo",
			eyes: "star",
			mouth: "tongue",
			headwear: "halo",
			accessory: "wand",
		},
	},
];

/** Every slot with its label and options, in wardrobe order. */
export const COSTUME_SLOTS: {
	slot: keyof GhostCostume;
	label: string;
	options: Record<string, string>;
}[] = [
	{
		slot: "palette",
		label: "Colour",
		options: Object.fromEntries(
			Object.entries(COSTUME_PALETTES).map(([id, palette]) => [
				id,
				palette.label,
			])
		),
	},
	{ slot: "finish", label: "Finish", options: COSTUME_FINISHES },
	{ slot: "eyes", label: "Eyes", options: COSTUME_EYES },
	{ slot: "brows", label: "Brows", options: COSTUME_BROWS },
	{ slot: "mouth", label: "Mouth", options: COSTUME_MOUTHS },
	{ slot: "ears", label: "Ears", options: COSTUME_EARS },
	{ slot: "headwear", label: "Headwear", options: COSTUME_HEADWEAR },
	{ slot: "glasses", label: "Glasses", options: COSTUME_GLASSES },
	{ slot: "accessory", label: "Accessory", options: COSTUME_ACCESSORIES },
	{ slot: "pattern", label: "Pattern", options: COSTUME_PATTERNS },
];

/** The preset a costume matches exactly, if any. */
export function costumePreset(costume: GhostCostume) {
	return GHOST_COSTUME_PRESETS.find((preset) =>
		COSTUME_SLOTS.every(({ slot }) => preset.costume[slot] === costume[slot])
	);
}

/** Slots a contributed accessory may fill (every slot but colour and finish). */
export function isGhostRegionSlot(slot: keyof GhostCostume): boolean {
	return GHOST_AVATAR_REGIONS.some((region) => region === slot);
}

/** Normalize a persisted costume: unknown slot values fall back to plain, and
 * contributed accessory ids are kept so they survive their plugin being off. */
const ghostCostumeInputSchema = z
	.unknown()
	.transform((data): GhostCostume | undefined => {
		if (!(data && isNativeObjectLike(data))) {
			return;
		}
		const costume = { ...PLAIN_COSTUME };
		for (const { slot, options } of COSTUME_SLOTS) {
			const value = observeNativeOptionalProperty(data, slot);
			if (
				isNativeText(value) &&
				(Object.hasOwn(options, value) ||
					(isGhostRegionSlot(slot) && isContributedPartId(value)))
			) {
				// SAFETY: The own-key check uses this slot's authored options; the
				// indexed assignment loses that correlation and intersects all slots.
				costume[slot] = value as never;
			}
		}
		return costume;
	});

/** Normalize raw persisted values through the owning input schema. */
export function parseGhostCostume(
	data: z.input<typeof ghostCostumeInputSchema>
): GhostCostume | undefined {
	return ghostCostumeInputSchema.parse(data);
}
