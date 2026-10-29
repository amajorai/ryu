import { describe, expect, test } from "bun:test";
import {
	CARD_FLIGHT,
	CARD_HOP,
	cardFlight,
	cardHop,
	cardStagger,
} from "./card-motion.ts";

describe("cardStagger", () => {
	test("a single card leaves at once", () => {
		expect(cardStagger(0)).toBe(0);
		expect(cardStagger(1)).toBe(0);
	});

	test("a small move staggers each card by the base step", () => {
		expect(cardStagger(5)).toBeCloseTo(0.045);
	});

	test("a big move shares one fixed window", () => {
		const movers = 52;
		expect(cardStagger(movers) * (movers - 1)).toBeCloseTo(0.6);
	});
});

describe("card transitions", () => {
	test("a flight arcs with the flight spring and keeps its delay", () => {
		const flight = cardFlight(0.09);
		expect(flight).toMatchObject({ ...CARD_FLIGHT, delay: 0.09 });
		expect(flight.path).toBeDefined();
	});

	test("every flight gets its own arc", () => {
		expect(cardFlight().path).not.toBe(cardFlight().path);
	});

	test("a hop arcs with the hop spring", () => {
		const hop = cardHop();
		expect(hop).toMatchObject(CARD_HOP);
		expect(hop.path).toBeDefined();
	});
});
