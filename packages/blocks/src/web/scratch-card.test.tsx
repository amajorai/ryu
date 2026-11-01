import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ScratchCard, { rubMask } from "./scratch-card.tsx";

const renderCard = () =>
	renderToStaticMarkup(
		<ScratchCard
			ariaLabel="Scratch the launch offer"
			caption="First month only"
			code="RYU10"
			discountLabel="10%"
			onProgress={() => undefined}
			onReveal={() => undefined}
			overlayLabel="Scratch to reveal"
			revealAnnouncement="Offer revealed"
		/>
	);

/** Records the brush stamps rubMask lays down. */
const recordingContext = () => {
	const stamps: { x: number; y: number; radius: number }[] = [];
	const ctx = {
		globalCompositeOperation: "source-over",
		fillStyle: "" as unknown,
		createRadialGradient: () => ({ addColorStop: () => undefined }),
		beginPath: () => undefined,
		arc: (x: number, y: number, radius: number) => {
			stamps.push({ x, y, radius });
		},
		fill: () => undefined,
	};
	return { ctx: ctx as unknown as CanvasRenderingContext2D, stamps, raw: ctx };
};

describe("ScratchCard", () => {
	test("keeps the rub interaction labelled and keyboard-revealable", () => {
		const html = renderCard();
		expect(html).toContain('aria-label="Scratch the launch offer"');
		expect(html).toContain('role="img"');
		expect(html).toContain("Can&#x27;t scratch? Reveal code");
		expect(html).toContain("RYU10");
	});

	test("hides the code under a blurred, aria-hidden copy instead of a solid foil", () => {
		const html = renderCard();
		const frostStart = html.indexOf('data-testid="scratch-card-frost"');
		expect(frostStart).toBeGreaterThan(-1);
		const frost = html.slice(frostStart);
		expect(frost).toContain("blur-[10px]");
		expect(frost).toContain('aria-hidden="true"');
		expect(frost).toContain("Scratch to reveal");
		// The rub canvas is an invisible mask, not a painted foil.
		expect(html).toMatch(/<canvas[^>]*opacity-0/);
		// Sharp reward plus the blurred copy.
		expect(html.split("RYU10").length - 1).toBe(2);
	});

	test("keeps the discount and code inside the card's margins", () => {
		const html = renderCard();
		expect(html).toContain("10% off");
		expect(html).toContain("@container");
		expect(html).toContain("text-[clamp(1.125rem,12cqi,2.25rem)]");
		expect(html).toContain("whitespace-nowrap");
	});
});

describe("rubMask", () => {
	test("erases with destination-out and leaves a gap-free trail on fast drags", () => {
		const { ctx, stamps, raw } = recordingContext();
		rubMask(ctx, { x: 0, y: 0 }, { x: 120, y: 0 }, 18);
		expect(raw.globalCompositeOperation).toBe("destination-out");
		expect(stamps[0]).toEqual({ x: 0, y: 0, radius: 18 });
		expect(stamps.at(-1)).toEqual({ x: 120, y: 0, radius: 18 });
		const xs = stamps.map((stamp) => stamp.x);
		for (const [index, x] of xs.slice(1).entries()) {
			expect(x - (xs[index] ?? 0)).toBeLessThanOrEqual(18);
		}
	});

	test("a single tap stamps the brush where the pointer landed", () => {
		const { ctx, stamps } = recordingContext();
		rubMask(ctx, { x: 40, y: 30 }, { x: 40, y: 30 }, 12);
		expect(stamps.every((stamp) => stamp.x === 40 && stamp.y === 30)).toBe(
			true
		);
		expect(stamps.length).toBeGreaterThan(0);
	});
});
