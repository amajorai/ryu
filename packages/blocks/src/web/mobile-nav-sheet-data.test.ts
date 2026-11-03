import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMPANY_ROUTES } from "./data/company.ts";
import {
	COMPANY_SHEET_GROUP,
	initialSheetGroup,
	RESOURCE_SHEET,
	SHEET_FOOTERS,
} from "./mobile-nav-sheet-data.ts";

const APP_DIR = fileURLToPath(
	new URL("../../../../apps/web/src/app/", import.meta.url)
);

test("the Company group links About, Careers, Press, and Events from COMPANY_ROUTES", () => {
	expect(COMPANY_SHEET_GROUP.title).toBe("Company");
	expect(COMPANY_SHEET_GROUP.links.map((link) => link.label)).toEqual([
		"About",
		"Careers",
		"Press",
		"Events",
	]);
	expect(COMPANY_SHEET_GROUP.links.map((link) => link.href)).toEqual([
		COMPANY_ROUTES.about,
		COMPANY_ROUTES.careers,
		COMPANY_ROUTES.press,
		COMPANY_ROUTES.events,
	]);
	for (const link of COMPANY_SHEET_GROUP.links) {
		expect(link.external).toBe(false);
		expect(link.description?.length).toBeGreaterThan(0);
		// Each row opens a page this site serves, not a 404.
		expect(existsSync(`${APP_DIR}${link.href.slice(1)}/page.tsx`)).toBe(true);
	}
});

test("the Resources sheet ends with Company and adds no footer", () => {
	expect(RESOURCE_SHEET.at(-1)).toBe(COMPANY_SHEET_GROUP);
	expect(SHEET_FOOTERS.resources).toEqual([]);
	const hrefs = RESOURCE_SHEET.flatMap((group) =>
		group.links.map((link) => link.href)
	);
	expect(new Set(hrefs).size).toBe(hrefs.length);
	expect(hrefs).toContain(COMPANY_ROUTES.knowledgeBase);
	expect(hrefs).not.toContain("/help");
});

test("the Resources sheet opens on the group that holds the current page", () => {
	expect(initialSheetGroup(RESOURCE_SHEET, "/about")).toBe("Company");
	expect(initialSheetGroup(RESOURCE_SHEET, "/press")).toBe("Company");
	expect(initialSheetGroup(RESOURCE_SHEET, "/events")).toBe("Company");
	expect(initialSheetGroup(RESOURCE_SHEET, "/knowledge-base")).toBe("Learn");
	expect(initialSheetGroup(RESOURCE_SHEET, "/pricing")).toBe("Plans");
	// A route only sharing a prefix string does not count as inside the group.
	expect(initialSheetGroup(RESOURCE_SHEET, "/aboutus")).toBe("Plans");
	expect(initialSheetGroup(RESOURCE_SHEET, "/")).toBe("Plans");
});
