import { describe, expect, test } from "bun:test";
import type { AgentPersona } from "@/src/lib/api/agents.ts";
import { glyphToPersonaFields, personaToGlyphValue } from "./agent-persona.ts";

describe("agent expressive avatar persona mapping", () => {
	test("maps a saved expressive mood and animation into the shared glyph", () => {
		const persona: AgentPersona = {
			display_name: null,
			expressive: { animation: "orbit", expression: "laughing" },
			tone: null,
		};

		expect(personaToGlyphValue(persona)).toEqual({
			animation: "orbit",
			kind: "expressive",
			expression: "laughing",
		});
	});

	test("serializes expressive glyphs and clears competing sources", () => {
		expect(
			glyphToPersonaFields({
				animation: "burst",
				expression: "happy",
				kind: "expressive",
			})
		).toEqual({
			avatar_style: null,
			avatar_url: null,
			dicebear: null,
			dither: null,
			expressive: { animation: "burst", expression: "happy" },
			emoji: null,
			icon: null,
			icon_color: null,
		});
	});
});

test("configured conversation ghost round-trips through agent persona fields", () => {
	const glyph = {
		kind: "expressive" as const,
		expression: "random" as const,
		animation: "random" as const,
		variant: "3d" as const,
		bodyStyle: "orb" as const,
		behavior: "conversation" as const,
		colors: { bg: "#ffffff", c1: "#ff6688" },
		animated: true,
		eyeScale: 1.25,
		animationDuration: 12,
	};
	const fields = glyphToPersonaFields(glyph);
	expect(
		personaToGlyphValue({ ...fields, display_name: null, tone: null })
	).toEqual(glyph);
	expect(fields.avatar_url).toBeNull();
	expect(fields.icon).toBeNull();
});

test("marketplace avatar styles round-trip with their region picks", () => {
	const glyph = {
		kind: "avatar_style" as const,
		style: "@acme/robots:robot",
		seed: "aria",
		palette: "rust",
		parts: { antenna: "@acme/hats:spring", eyes: "visor" },
	};
	const fields = glyphToPersonaFields(glyph);
	expect(fields.avatar_style).toEqual({
		style: glyph.style,
		seed: glyph.seed,
		palette: glyph.palette,
		parts: glyph.parts,
	});
	expect(fields.dicebear).toBeNull();
	expect(fields.dither).toBeNull();
	expect(
		personaToGlyphValue({ display_name: null, tone: null, ...fields })
	).toEqual(glyph);
});
