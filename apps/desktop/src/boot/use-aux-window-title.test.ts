import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { applyAuxWindowTitle, auxWindowTitle } from "./use-aux-window-title.ts";

/** A `tl` stand-in that answers from a fixed catalog, then fills `{product}`. */
function literalMessages(catalog: Record<string, string>): LiteralMessage {
	return (source, values) =>
		(catalog[source] ?? source).replace(
			"{product}",
			String((values as Record<string, unknown> | undefined)?.product)
		);
}

const english = literalMessages({});
const german = literalMessages({
	"Live Media": "Live-Medien",
	"Ryu · {product}": "Ryu · {product}",
});
const arabic = literalMessages({
	"Live Media": "الوسائط المباشرة",
	"Ryu · {product}": "{product} · Ryu",
});

describe("auxiliary window titles", () => {
	test("formats the product into the shared Ryu title", () => {
		expect(auxWindowTitle(english, english("Companion"))).toBe(
			"Ryu · Companion"
		);
		expect(auxWindowTitle(english, english("Live Media"))).toBe(
			"Ryu · Live Media"
		);
	});

	test("uses the reader's catalog for both the frame and the product", () => {
		expect(auxWindowTitle(german, german("Live Media"))).toBe(
			"Ryu · Live-Medien"
		);
		expect(auxWindowTitle(arabic, arabic("Live Media"))).toBe(
			"الوسائط المباشرة · Ryu"
		);
	});

	test("writes the translated title to the native window", async () => {
		const titles: string[] = [];
		await applyAuxWindowTitle(
			auxWindowTitle(german, german("Live Media")),
			async () => ({
				setTitle: async (title: string) => {
					titles.push(title);
				},
			})
		);
		expect(titles).toEqual(["Ryu · Live-Medien"]);
	});

	test("swallows a failed native title write", async () => {
		await expect(
			applyAuxWindowTitle("Ryu · Live Media", async () => ({
				setTitle: () => Promise.reject(new Error("no window")),
			}))
		).resolves.toBeUndefined();
	});
});
