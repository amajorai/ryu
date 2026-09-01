import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "header.tsx"), "utf8");
const PRODUCTS_MENU = SOURCE.slice(
	SOURCE.indexOf("function ProductsMenu"),
	SOURCE.indexOf("function isHeaderLinkActive")
);
const MARKETING_LINKS = SOURCE.slice(
	SOURCE.indexOf("function HeaderLinkList"),
	SOURCE.indexOf("function PortalMobileNavigation")
);
const PORTAL_HEADER = SOURCE.slice(
	SOURCE.indexOf('if (variant === "portal")'),
	SOURCE.indexOf("\n\treturn (\n\t\t<div className={`relative")
);

test("marketing product menu participates in the shared hover morph", () => {
	expect(PRODUCTS_MENU).toContain("<MotionNavigationMenuTrigger");
	expect(PRODUCTS_MENU).toContain("<MotionNavigationMenuContent>");
	expect(PRODUCTS_MENU).not.toContain("<DropdownMenu>");
});

test("marketing product labels avoid repeating the Ryu prefix", () => {
	expect(SOURCE).toContain(
		"map(({ href, shortLabel }) => ({ href, label: shortLabel }))"
	);
	expect(SOURCE).toContain('{ href: "/marketplace/apps", label: "Apps" }');
	expect(SOURCE).toContain('label: "Cloud"');
	expect(SOURCE).toContain("Explore the platform →");
});

test("marketing marketplace link keeps the readable header treatment", () => {
	expect(MARKETING_LINKS).toContain(
		'"text-foreground hover:bg-muted hover:text-foreground"'
	);
	expect(MARKETING_LINKS).not.toContain(
		'"text-muted-foreground hover:bg-muted hover:text-foreground"'
	);
});

test("portal header orders account, org, and utilities without the brand block", () => {
	expect(PORTAL_HEADER).not.toContain("<Logo");
	expect(PORTAL_HEADER.indexOf("{userMenu ?")).toBeLessThan(
		PORTAL_HEADER.indexOf("{orgSlot ?")
	);
	expect(PORTAL_HEADER.indexOf("{orgSlot ?")).toBeLessThan(
		PORTAL_HEADER.indexOf("{portalUtilityMenu ?")
	);
	expect(PORTAL_HEADER).toContain('aria-hidden="true"');
	expect(PORTAL_HEADER).toContain(">\n\t\t\t\t\t\t\t\t\t\t/\n");
	expect(PORTAL_HEADER).toContain("{portalContextNav ?");
	expect(PORTAL_HEADER).toContain('aria-label="Back to dashboard"');
	expect(PORTAL_HEADER).toContain('href="/dashboard"');
	expect(PORTAL_HEADER).toContain(
		'"flex min-h-14 items-center gap-2 px-4 sm:px-6"'
	);
	expect(PORTAL_HEADER).not.toContain(
		'"flex min-h-14 items-center gap-3 px-4 sm:gap-4 sm:px-6"'
	);
});

test("portal inverse header swaps the surface roles without a divider", () => {
	expect(PORTAL_HEADER).toContain("bg-foreground text-background");
	expect(PORTAL_HEADER).toContain("border-border/70 border-b bg-background/85");
	expect(PORTAL_HEADER).toContain("text-background/40");
});
