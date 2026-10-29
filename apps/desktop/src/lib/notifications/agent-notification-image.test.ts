import { describe, expect, test } from "bun:test";
import { planAgentAvatar } from "./agent-notification-image.ts";

const base = { id: "agent-1", name: "Nova" };

describe("planAgentAvatar", () => {
	test("an uploaded avatar is drawn edge to edge", () => {
		const plan = planAgentAvatar({
			...base,
			avatarGlyph: { kind: "avatar", dataUrl: "data:image/png;base64,AAAA" },
		});
		expect(plan).toEqual({
			kind: "image",
			src: "data:image/png;base64,AAAA",
			background: null,
		});
	});

	test("a bare avatarUrl is used when no glyph is set", () => {
		const plan = planAgentAvatar({
			...base,
			avatarUrl: "https://cdn.example.com/nova.png",
		});
		expect(plan).toMatchObject({
			kind: "image",
			src: "https://cdn.example.com/nova.png",
		});
	});

	test("unsafe avatar URLs fall back to a monogram", () => {
		const plan = planAgentAvatar({
			...base,
			avatarGlyph: { kind: "avatar", dataUrl: "javascript:alert(1)" },
		});
		expect(plan).toMatchObject({ kind: "monogram", letter: "N" });
	});

	test("emoji keep their dither colour as the tile", () => {
		const plan = planAgentAvatar({
			...base,
			avatarGlyph: {
				kind: "emoji",
				emoji: "🦊",
				dither: { from: "blue", to: null, direction: "up" },
			},
		});
		expect(plan).toEqual({
			kind: "emoji",
			emoji: "🦊",
			background: "rgba(53,143,243,1)",
		});
	});

	test("DiceBear and icon glyphs resolve to their image services", () => {
		const dicebear = planAgentAvatar({
			...base,
			avatarGlyph: { kind: "dicebear", style: "notionists", seed: "nova" },
		});
		expect(dicebear).toMatchObject({ kind: "image" });
		expect(dicebear.kind === "image" && dicebear.src).toStartWith(
			"https://api.dicebear.com/9.x/notionists/svg?seed=nova"
		);

		const icon = planAgentAvatar({
			...base,
			avatarGlyph: { kind: "icon", id: "hugeicons:robot-01", color: "#ef4444" },
		});
		expect(icon.kind === "image" && icon.src).toStartWith(
			"https://api.iconify.design/hugeicons/robot-01.svg"
		);
	});

	test("animated avatars become a monogram in their colour", () => {
		const first = planAgentAvatar({
			...base,
			avatarGlyph: {
				kind: "dither",
				dither: { from: "green", to: null, direction: "up" },
			},
		});
		expect(first).toEqual({
			kind: "monogram",
			letter: "N",
			background: "rgba(40,210,110,1)",
		});
	});

	test("agents with no avatar or engine fall back to the Ryu mark", () => {
		expect(
			planAgentAvatar({ ...base, avatarGlyph: null, logoSrc: null })
		).toMatchObject({ kind: "image", src: "/assets/logos/ryu_light.svg" });
	});

	test("agents without a custom avatar use their engine logo", () => {
		expect(
			planAgentAvatar({
				...base,
				avatarGlyph: null,
				logoSrc: "/assets/logos/claude.svg",
			})
		).toMatchObject({ kind: "image", src: "/assets/logos/claude.svg" });
	});
});
