import { describe, expect, it } from "bun:test";
import { initialStateFor, renderSpecHeaderSchema } from "./render-spec.ts";

describe("native Agent UI header boundary", () => {
	it("retains empty, inherited and array element carriers without decoding nodes", () => {
		const inherited = Object.create({
			root: { type: "FutureComponent", props: { native: true } },
		});
		const carriers = [
			{ root: "", elements: {} },
			{ root: "root", elements: inherited },
			{ root: "0", elements: [{ type: 42, props: {}, children: [] }] },
			Object.assign([], { root: "root", elements: {} }),
		];
		for (const carrier of carriers) {
			const result = renderSpecHeaderSchema.safeParse(carrier);
			expect(result.success).toBe(true);
			expect(result.success && Object.is(result.data, carrier)).toBe(true);
		}
	});

	it("preserves the original elements getter read order", () => {
		let reads = 0;
		const changingHeader = {
			root: "root",
			get elements() {
				reads += 1;
				return reads === 1 ? null : {};
			},
		};
		expect(renderSpecHeaderSchema.safeParse(changingHeader).success).toBe(true);
		expect(reads).toBe(2);
		reads = 0;
		const invalidKind = {
			root: "root",
			get elements() {
				reads += 1;
				return reads === 1 ? "invalid" : {};
			},
		};
		expect(renderSpecHeaderSchema.safeParse(invalidKind).success).toBe(false);
		expect(reads).toBe(1);
	});

	it("keeps native state identity and excludes state arrays and function carriers", () => {
		const state = Object.assign(new Map([["metadata", new Date(0)]]), {
			native: true,
		});
		expect(Object.is(initialStateFor({ state }), state)).toBe(true);
		expect(initialStateFor({ state: [] })).toBeUndefined();
		expect(initialStateFor(Object.assign([], { state }))).toBeUndefined();
		expect(
			renderSpecHeaderSchema.safeParse(
				Object.assign(() => undefined, { root: "root", elements: {} })
			).success
		).toBe(false);
		expect(
			renderSpecHeaderSchema.safeParse({ root: 42, elements: {} }).success
		).toBe(false);
		expect(
			renderSpecHeaderSchema.safeParse({ root: "root", elements: null }).success
		).toBe(false);
	});
});
