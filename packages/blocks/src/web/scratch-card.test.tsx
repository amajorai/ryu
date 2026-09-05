import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ScratchCard from "./scratch-card.tsx";

describe("ScratchCard", () => {
	test("keeps the foil interaction labelled and keyboard-revealable", () => {
		const html = renderToStaticMarkup(
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
		expect(html).toContain('aria-label="Scratch the launch offer"');
		expect(html).toContain('role="img"');
		expect(html).toContain("Can&#x27;t scratch? Reveal code");
		expect(html).toContain("RYU10");
	});
});
