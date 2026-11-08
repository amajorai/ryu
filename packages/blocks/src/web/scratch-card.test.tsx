import { describe, expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
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

	test("covers the code with a canvas foil instead of a masked DOM copy", () => {
		const html = renderCard();
		// The foil is painted on the rub canvas, which stays visible.
		expect(html).toContain('data-testid="scratch-card-foil"');
		expect(html).not.toMatch(/<canvas[^>]*opacity-0/);
		expect(html).toContain("Scratch to reveal");
		// No second (blurred) DOM copy of the code whose CSS mask could flash
		// the whole reward while it is swapped mid-rub.
		expect(html).not.toContain("scratch-card-frost");
		expect(html).not.toContain("mask-image");
		expect(html.split("RYU10").length - 1).toBe(1);
		// The reward lines the foil re-draws blurred are tagged.
		expect(html.split("data-foil-text").length - 1).toBe(3);
	});

	test("keeps the discount and code inside the card's margins", () => {
		const html = renderCard();
		expect(html).toContain("10% off");
		expect(html).toContain("@container");
		expect(html).toContain("text-[clamp(1.125rem,12cqi,2.25rem)]");
		expect(html).toContain("whitespace-nowrap");
	});

	test("formats discountPercent in the reader's number format", () => {
		const percentCard = (locale: string) =>
			renderToStaticMarkup(
				<I18nProvider initialLocale={locale}>
					<ScratchCard code="LAUNCH30" discountPercent={30} />
				</I18nProvider>
			);
		expect(percentCard("en")).toContain(">30% off<");
		// French puts a no-break space (narrow in current ICU) before the sign.
		const french = new Intl.NumberFormat("fr", { style: "percent" }).format(
			0.3
		);
		expect(french).toMatch(/^30[\u00a0\u202f]%$/u);
		expect(percentCard("fr")).toContain(`>${french} off<`);
		expect(percentCard("fr")).not.toContain(">30% off<");
		for (const locale of ["de", "tr", "ar"]) {
			const expected = new Intl.NumberFormat(locale, {
				style: "percent",
			}).format(0.3);
			expect(percentCard(locale)).toContain(`>${expected} off<`);
		}
		// Turkish puts the sign before the number.
		expect(percentCard("tr")).toContain(">%30 off<");
	});

	test("keeps a preformatted discountLabel as an override", () => {
		const html = renderToStaticMarkup(
			<ScratchCard code="X" discountLabel="Half" discountPercent={50} />
		);
		expect(html).toContain("Half off");
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
