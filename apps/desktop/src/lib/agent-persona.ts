import { isDitherColor } from "@ryu/ui/components/dither-kit/palette.ts";
import { parseGhostAvatar } from "@ryu/ui/components/ghost-avatar.ts";
import {
	asGlyphValue,
	type GlyphDitherValue,
	type GlyphValue,
	isGlyphIconColor,
} from "@ryu/ui/components/glyph.ts";
import type { AgentPersona } from "@/src/lib/api/agents.ts";

// Persona ⇄ GlyphPicker conversion.
//
// An agent's avatar has seven mutually-exclusive sources (uploaded image, icon,
// emoji, dicebear, expressive, marketplace avatar style, dither), with dither
// additionally allowed as a BACKGROUND
// behind an icon or emoji. Getting that exclusivity wrong writes two sources at
// once and the wrong one wins at render.
//
// These lived inside `AgentEditPage` until the create-agent dialog needed the
// same conversion. Copying them would have been the third place in this repo to
// duplicate logic instead of moving it, so they moved here.

/** Fold a saved persona into a GlyphPicker value. */
export function personaToGlyphValue(
	persona: AgentPersona | null | undefined
): GlyphValue {
	if (!persona) {
		return null;
	}
	if (persona.avatar_url) {
		return { kind: "avatar", dataUrl: persona.avatar_url };
	}
	const expressive = parseGhostAvatar(persona.expressive);
	if (expressive) {
		return { ...expressive, kind: "expressive" };
	}
	const ditherLayer: GlyphDitherValue | undefined =
		persona.dither && isDitherColor(persona.dither.from)
			? {
					from: persona.dither.from,
					to: isDitherColor(persona.dither.to) ? persona.dither.to : null,
					direction:
						persona.dither.direction === "down" ||
						persona.dither.direction === "left" ||
						persona.dither.direction === "right"
							? persona.dither.direction
							: "up",
				}
			: undefined;
	if (persona.emoji) {
		if (persona.emoji.length > 32) {
			return null;
		}
		return {
			kind: "emoji",
			emoji: persona.emoji,
			...(ditherLayer ? { dither: ditherLayer } : undefined),
		};
	}
	if (persona.icon) {
		const color = isGlyphIconColor(persona.icon_color)
			? persona.icon_color
			: undefined;
		return {
			kind: "icon",
			id: persona.icon,
			...(color ? { color } : undefined),
			...(ditherLayer ? { dither: ditherLayer } : undefined),
		};
	}
	if (persona.dicebear?.style && persona.dicebear.seed) {
		return {
			kind: "dicebear",
			style: persona.dicebear.style,
			seed: persona.dicebear.seed,
		};
	}
	if (persona.avatar_style?.style && persona.avatar_style.seed) {
		const styled = asGlyphValue({
			kind: "avatar_style",
			style: persona.avatar_style.style,
			seed: persona.avatar_style.seed,
			palette: persona.avatar_style.palette ?? undefined,
			parts: persona.avatar_style.parts ?? undefined,
		});
		if (styled?.kind === "avatar_style") {
			return styled;
		}
	}
	if (ditherLayer) {
		return { kind: "dither", dither: ditherLayer };
	}
	return null;
}

/** Split a GlyphPicker value into persona avatar fields.
 * Dither may coexist with icon/emoji as a background; never with dicebear/avatar. */
export function glyphToPersonaFields(
	glyph: GlyphValue
): Pick<
	AgentPersona,
	| "avatar_url"
	| "emoji"
	| "icon"
	| "icon_color"
	| "dicebear"
	| "expressive"
	| "avatar_style"
	| "dither"
> {
	const ditherBg =
		glyph?.kind === "icon" || glyph?.kind === "emoji"
			? (glyph.dither ?? null)
			: glyph?.kind === "dither"
				? glyph.dither
				: null;
	return {
		avatar_url: glyph?.kind === "avatar" ? glyph.dataUrl : null,
		expressive:
			glyph?.kind === "expressive" ? (parseGhostAvatar(glyph) ?? null) : null,
		emoji: glyph?.kind === "emoji" ? glyph.emoji : null,
		icon: glyph?.kind === "icon" ? glyph.id : null,
		icon_color: glyph?.kind === "icon" ? (glyph.color ?? null) : null,
		dicebear:
			glyph?.kind === "dicebear"
				? { style: glyph.style, seed: glyph.seed }
				: null,
		avatar_style:
			glyph?.kind === "avatar_style"
				? {
						style: glyph.style,
						seed: glyph.seed,
						palette: glyph.palette ?? null,
						parts: glyph.parts ?? null,
					}
				: null,
		dither: ditherBg,
	};
}
