// Render tests for the shared star-rating primitives. The read-only StarRating
// carries the accessible average as an aria-label (rounded to one decimal) and an
// optional review count; the interactive StarRatingInput exposes one labeled
// button per star with aria-pressed reflecting the current value. Static markup,
// no DOM — the same idiom as the rest of the package.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StarRating, StarRatingInput } from "./star-rating.tsx";

describe("StarRating", () => {
	test("without a count the aria-label omits the reviews clause", () => {
		const html = renderToStaticMarkup(<StarRating value={4} />);
		expect(html).toContain('aria-label="Rated 4 out of 5"');
		expect(html).not.toContain("reviews");
	});

	test("a count renders the reviews clause and the (N) suffix", () => {
		const html = renderToStaticMarkup(<StarRating count={12} value={4} />);
		expect(html).toContain("Rated 4 out of 5 from 12 reviews");
		expect(html).toContain("(12)");
	});

	test("the average is rounded to one decimal in the label", () => {
		// Math.round(4.25 * 10) / 10 = 4.3
		const html = renderToStaticMarkup(<StarRating value={4.25} />);
		expect(html).toContain("Rated 4.3 out of 5");
	});

	test("showValue renders the numeric average with one fixed decimal", () => {
		const html = renderToStaticMarkup(<StarRating showValue value={3} />);
		expect(html).toContain("3.0");
	});

	test("a fractional value renders a half star (StarHalf overlay present)", () => {
		// value 3.5 -> position 4 is a half star; the overlay uses fill-warning.
		const html = renderToStaticMarkup(<StarRating value={3.5} />);
		expect(html).toContain("fill-warning");
	});

	test("role=img marks the whole widget as a single graphic", () => {
		const html = renderToStaticMarkup(<StarRating value={5} />);
		expect(html).toContain('role="img"');
	});
});

describe("StarRatingInput", () => {
	test("renders five labeled buttons, singular for the first", () => {
		const html = renderToStaticMarkup(
			<StarRatingInput onChange={() => undefined} value={0} />
		);
		expect(html).toContain('aria-label="1 star"');
		expect(html).toContain('aria-label="2 stars"');
		expect(html).toContain('aria-label="5 stars"');
	});

	test("aria-pressed marks the currently selected star", () => {
		const html = renderToStaticMarkup(
			<StarRatingInput onChange={() => undefined} value={3} />
		);
		// The selected (3-star) button is pressed; a different one is not.
		expect(html).toContain('aria-label="3 stars" aria-pressed="true"');
		expect(html).toContain('aria-label="4 stars" aria-pressed="false"');
	});

	test("disabled propagates to every star button", () => {
		const html = renderToStaticMarkup(
			<StarRatingInput disabled onChange={() => undefined} value={2} />
		);
		expect(html).toContain("disabled");
	});
});
