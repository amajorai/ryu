import { expect, test } from "bun:test";
import { PRODUCT_SECTION_NAV } from "../archetypes.ts";
import type { ProductSectionKey } from "../profile-types.ts";
import {
	groupSections,
	HEAD_SECTION_KEYS,
	renderedKeys,
	sectionAnchorId,
	sectionNavItems,
	splitHead,
} from "./layout-plan.ts";

test("rendered keys keep the order and drop empty slots", () => {
	const order: ProductSectionKey[] = [
		"hero",
		"figure",
		"statement",
		"code",
		"cta",
	];
	expect(renderedKeys(order, (key) => key !== "code")).toEqual([
		"hero",
		"figure",
		"statement",
		"cta",
	]);
});

test("the head is the hero and figure; everything else is the body", () => {
	expect(HEAD_SECTION_KEYS).toEqual(["hero", "figure"]);
	expect(splitHead(["hero", "figure", "statement", "faq"])).toEqual({
		head: ["hero", "figure"],
		body: ["statement", "faq"],
	});
	// A figure listed after a signature section stays in the body, in order.
	expect(splitHead(["hero", "code", "figure", "statement"])).toEqual({
		head: ["hero"],
		body: ["code", "figure", "statement"],
	});
});

test("nav items follow page order, skip unlisted keys and never repeat an id", () => {
	expect(
		sectionNavItems([
			"statement",
			"built-for",
			"features",
			"explorer",
			"faq",
			"cta",
		])
	).toEqual([
		{ id: "overview", label: "Overview" },
		{ id: "features", label: "Features" },
		{ id: "faq", label: "FAQ" },
	]);
	expect(sectionAnchorId("pricing")).toBe("pricing");
	expect(sectionAnchorId("cta")).toBeUndefined();
	expect(sectionAnchorId("guardrail")).toBe(PRODUCT_SECTION_NAV.guardrail?.id);
});

test("a side-by-side pair groups only when both halves are adjacent", () => {
	const pair = ["code", "interfaces"] as const;
	expect(
		groupSections(["statement", "code", "interfaces", "api"], pair)
	).toEqual([
		{ kind: "single", key: "statement" },
		{ kind: "pair", keys: ["code", "interfaces"] },
		{ kind: "single", key: "api" },
	]);
	expect(groupSections(["code", "api", "interfaces"], pair)).toEqual([
		{ kind: "single", key: "code" },
		{ kind: "single", key: "api" },
		{ kind: "single", key: "interfaces" },
	]);
	expect(groupSections(["code", "interfaces"])).toEqual([
		{ kind: "single", key: "code" },
		{ kind: "single", key: "interfaces" },
	]);
});
