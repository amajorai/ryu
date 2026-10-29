import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
	PlanBadge,
	type PlanTier,
	planCardConicGradient,
	planTierColors,
	planTierGradient,
} from "./plan-badge.tsx";

const GLOBALS_URL = "../styles/globals.css";
const GLOBALS_PARTIAL_IMPORT = /@import "(\.\/globals\/[\w-]+\.css)";/g;

/** globals.css with its ordered `./globals/*.css` partials inlined. */
function readGlobalsCss(): string {
	const url = new URL(GLOBALS_URL, import.meta.url);
	return readFileSync(url, "utf8").replace(
		GLOBALS_PARTIAL_IMPORT,
		(_statement, partial: string) => readFileSync(new URL(partial, url), "utf8")
	);
}

const BUSINESS_GRADIENT =
	"linear-gradient(15deg,#5dffe4 0,#8dff9a 8%,#fff36a 16%,#60dfff 24%,#7b7cff 32%,#ff77d8 40%,#ffc45f 48%,#5dffe4 56%,#8dff9a 64%,#fff36a 72%,#60dfff 80%,#7b7cff 88%,#ff77d8 96%,#ffc45f 100%)";
const PRO_GRADIENT =
	"linear-gradient(15deg,#9effef 0,#d1ffd6 17%,#fff8ad 34%,#a3edff 51%,#bdbdff 68%,#ffb8eb 85%,#ffdda3 100%)";
const TEAMS_GRADIENT =
	"linear-gradient(180deg,#031c26 0%,#1b6aa7 43%,#57d2f4 100%)";
const A_MAJOR_PASS_GRADIENT =
	"linear-gradient(135deg,#090613 0%,#2b348f 30%,#655be0 52%,#de5c9f 73%,#ff941f 100%)";
const DESKTOP_GRADIENT = "linear-gradient(15deg,#fff1b8 0%,#c8942e 100%)";

describe("Business plan badge", () => {
	test("renders the Business label, title, and requested palette", () => {
		const html = renderToStaticMarkup(<PlanBadge plan="business" size="md" />);

		expect(html).toContain("BUSINESS");
		expect(html).toContain('title="Ryu Business"');
		expect(html).toContain("var(--plan-tier-business-gradient)");
		expect(html).toContain("t-plan-badge-gradient");
		expect(planTierGradient("business")).toBe(BUSINESS_GRADIENT);
		expect(planTierColors("business")).toEqual([
			"#5dffe4",
			"#8dff9a",
			"#fff36a",
			"#60dfff",
			"#7b7cff",
			"#ff77d8",
			"#ffc45f",
			"#5dffe4",
			"#8dff9a",
			"#fff36a",
			"#60dfff",
			"#7b7cff",
			"#ff77d8",
			"#ffc45f",
		]);
	});
});

describe("Pro plan badge", () => {
	test("keeps its separate holographic pastel palette", () => {
		const html = renderToStaticMarkup(<PlanBadge plan="pro" size="md" />);

		expect(planTierGradient("pro")).toBe(PRO_GRADIENT);
		expect(planTierGradient("pro")).not.toBe(BUSINESS_GRADIENT);
		expect(html).toContain("t-plan-badge-gradient");
	});
});

describe("Plus plan badge", () => {
	test("renders the private companion label, title, and palette", () => {
		const html = renderToStaticMarkup(<PlanBadge plan="plus" size="md" />);

		expect(html).toContain("PLUS");
		expect(html).toContain('title="Ryu Plus"');
		expect(planTierGradient("plus")).toContain("#56faf7");
		expect(planTierGradient("plus")).toContain("#a162ff");
		expect(planTierColors("plus")).toEqual([
			"#e2dfd8",
			"#56faf7",
			"#a162ff",
			"#f8dcbb",
		]);
	});
});

describe("Teams Lite plan badge", () => {
	test("keeps the Teams palette while naming the private tier", () => {
		const html = renderToStaticMarkup(
			<PlanBadge plan="teams-lite" size="md" />
		);

		expect(html).toContain("TEAMS LITE");
		expect(html).toContain('title="Ryu Teams Lite"');
		expect(planTierGradient("teams-lite")).toBe(TEAMS_GRADIENT);
		expect(planTierColors("teams-lite")).toEqual([
			"#031c26",
			"#1b6aa7",
			"#57d2f4",
		]);
	});
});

describe("Teams plan badge", () => {
	test("uses the blue Silk Blend gradient without its white stop", () => {
		const html = renderToStaticMarkup(<PlanBadge plan="teams" size="md" />);

		expect(planTierGradient("teams")).toBe(TEAMS_GRADIENT);
		expect(planTierColors("teams")).toEqual(["#031c26", "#1b6aa7", "#57d2f4"]);
		expect(html).toContain("var(--plan-tier-teams-gradient)");
	});
});

describe("Plan badge background motion", () => {
	const plans: PlanTier[] = [
		"pro",
		"plus",
		"max",
		"teams",
		"teams-lite",
		"business",
		"enterprise",
		"marketplace-membership",
		"desktop-license",
	];

	test.each(plans)("animates the %s gradient face at both sizes", (plan) => {
		for (const size of ["sm", "md"] as const) {
			const html = renderToStaticMarkup(<PlanBadge plan={plan} size={size} />);
			expect(html).toContain("t-plan-badge-gradient");
			expect(html).toContain(`var(--plan-tier-${plan}-gradient)`);
			if (plan === "business") {
				expect(html).toContain("t-plan-badge-business-gradient");
			} else {
				expect(html).not.toContain("t-plan-badge-business-gradient");
			}
		}
	});

	test("uses a shared enlarged drift animation with a reduced-motion stop", () => {
		const css = readGlobalsCss();

		expect(css).toContain("@keyframes t-plan-badge-gradient-drift");
		expect(css).toContain("background-size: 300% 100%");
		expect(css).toContain("background-size: 500% 100%");
		expect(css).toContain("background-size: 180% 100%");
		expect(css).toContain(
			"animation: t-plan-badge-gradient-drift 8s ease-in-out infinite"
		);
		expect(
			css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"))
		).toContain(".t-plan-badge-gradient");
	});
});

describe("A Major Pass plan badge", () => {
	test("renders its own label, title, and palette", () => {
		const html = renderToStaticMarkup(
			<PlanBadge plan="marketplace-membership" size="md" />
		);

		expect(html).toContain("A MAJOR PASS");
		expect(html).toContain('title="Ryu A Major Pass"');
		expect(planTierGradient("marketplace-membership")).toBe(
			A_MAJOR_PASS_GRADIENT
		);
		expect(planTierColors("marketplace-membership")).toEqual([
			"#090613",
			"#2b348f",
			"#655be0",
			"#de5c9f",
			"#ff941f",
		]);
	});
});

describe("pricing card gradient palettes", () => {
	test("uses the supplied logo colors for the no-plan Gateway PAYG offer", () => {
		expect(planCardConicGradient("gateway-payg")).toBe(
			"conic-gradient(from var(--tier-border-angle),#1e0b33,#354389,#624c95,#a73455,#f83d34,#f3a316,#1e0b33)"
		);
	});

	test("reuses each plan badge palette for its pricing-card border", () => {
		const plans: PlanTier[] = [
			"marketplace-membership",
			"plus",
			"pro",
			"max",
			"teams",
			"teams-lite",
			"business",
			"enterprise",
			"desktop-license",
		];

		for (const plan of plans) {
			const colors = planTierColors(plan);
			expect(planCardConicGradient(plan)).toBe(
				[
					"conic-gradient(from var(--tier-border-angle),",
					[...colors, colors[0]].join(","),
					")",
				].join("")
			);
		}
	});
});

describe("Desktop plan badge", () => {
	test("uses the gold palette previously used by A Major Pass", () => {
		const html = renderToStaticMarkup(
			<PlanBadge plan="desktop-license" size="md" />
		);

		expect(planTierGradient("desktop-license")).toBe(DESKTOP_GRADIENT);
		expect(planTierColors("desktop-license")).toEqual(["#fff1b8", "#c8942e"]);
		expect(html).toContain("var(--plan-tier-desktop-license-gradient)");
	});
});

describe("Enterprise plan badge", () => {
	test("renders the original green enterprise palette", () => {
		const html = renderToStaticMarkup(
			<PlanBadge plan="enterprise" size="md" />
		);

		expect(html).toContain("ENTERPRISE");
		expect(html).toContain("var(--plan-tier-enterprise-gradient)");
		expect(planTierColors("enterprise")).toEqual([
			"#0f766e",
			"#059669",
			"#84cc16",
			"#f59e0b",
		]);
	});
});

test("theme gradient projections match the public tier palette helpers", async () => {
	const css = await Bun.file(
		new URL("../styles/plan-tier-colors.css", import.meta.url)
	).text();
	const plans: PlanTier[] = [
		"pro",
		"plus",
		"max",
		"teams",
		"teams-lite",
		"business",
		"enterprise",
		"marketplace-membership",
		"desktop-license",
	];
	for (const plan of plans) {
		expect(css.replaceAll(/\s+/g, "")).toContain(
			`--plan-tier-${plan}-gradient:${planTierGradient(plan).replaceAll(/\s+/g, "")};`
		);
	}
});

test("plan-tier tokens load in globals and the isolated docs preview", async () => {
	const globals = await Bun.file(
		new URL("../styles/globals.css", import.meta.url)
	).text();
	const docsPreview = await Bun.file(
		new URL("../../../../apps/fumadocs/src/app/ui-preview.css", import.meta.url)
	).text();
	expect(globals).toContain('@import "./plan-tier-colors.css";');
	expect(docsPreview).toContain('@import "@ryu/ui/plan-tier-colors.css";');
});
