import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { PATTERNCRAFT_WALLPAPERS } from "@ryu/ui/components/backdrop/patterncraft-wallpapers.generated.ts";

const PROOF_DIR = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/wallpaper-backgrounds/store-library-tabs"
);
const MESH_GRADIENT_ID = "com.ryu.marketplace-defaults:mesh-gradient";

test("Marketplace and Library install and apply host-rendered wallpapers", async ({
	page,
}) => {
	await mkdir(PROOF_DIR, { recursive: true });
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.addInitScript(() => localStorage.clear());
	await page.route(
		/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/api\//,
		(route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: "{}",
			})
	);
	await page.goto("/wallpaper-catalog-pages-proof.html");

	const marketplace = page.getByTestId("wallpaper-marketplace-section");
	await expect(marketplace).toBeVisible();
	await expect(page.getByRole("tab", { name: /^Wallpapers/ })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(page.getByTestId("wallpaper-catalog-count")).toHaveText(
		"260 of 260 wallpapers"
	);

	const meshGradient = page.getByTestId(
		`wallpaper-catalog-card-${MESH_GRADIENT_ID}`
	);
	await expect(meshGradient).toBeVisible();
	await meshGradient.getByRole("button", { name: "Install" }).click();
	await expect(
		meshGradient.getByRole("button", { name: "In Library" })
	).toBeDisabled();
	await meshGradient.getByRole("button", { name: "Use wallpaper" }).click();
	await expect(page.getByTestId("active-wallpaper-id")).toHaveText(
		`backdrop:${MESH_GRADIENT_ID}`
	);
	await expect(
		page.locator('[data-testid="active-wallpaper-proof"] [data-wallpaper-id]')
	).toHaveAttribute("data-wallpaper-id", `backdrop:${MESH_GRADIENT_ID}`);
	await page.getByTestId("product-page").screenshot({
		path: path.join(PROOF_DIR, "marketplace-wallpapers-tab.png"),
	});
	await page
		.getByTestId("active-wallpaper-proof")
		.screenshot({ path: path.join(PROOF_DIR, "remocn-shader-adapter.png") });

	await page.getByTestId("open-library").click();
	const library = page.getByTestId("wallpaper-library-section");
	await expect(library).toBeVisible();
	await expect(page.getByTestId("wallpaper-catalog-count")).toHaveText(
		"1 of 1 wallpapers"
	);
	await expect(
		page.getByTestId(`wallpaper-catalog-card-${MESH_GRADIENT_ID}`)
	).toBeVisible();

	const pattern = PATTERNCRAFT_WALLPAPERS[0];
	if (!pattern) {
		throw new Error("The pinned PatternCraft catalog is empty.");
	}
	await page.getByTestId("open-marketplace").click();
	const search = page.getByRole("textbox", { name: "Search wallpapers" });
	await search.fill(pattern.label);
	const patternId = `com.ryu.patterncraft:${pattern.slug}`;
	const patternCard = page.getByTestId(`wallpaper-catalog-card-${patternId}`);
	await expect(patternCard).toBeVisible();
	await patternCard.getByRole("button", { name: "Install" }).click();
	await patternCard.getByRole("button", { name: "Use wallpaper" }).click();
	await expect(page.getByTestId("active-wallpaper-id")).toHaveText(
		`backdrop:${patternId}`
	);
	await expect(
		page.locator(
			'[data-testid="active-wallpaper-proof"] [data-backdrop-renderer="marketplace-css"]'
		)
	).toBeVisible();
	await page
		.getByTestId("active-wallpaper-proof")
		.screenshot({ path: path.join(PROOF_DIR, "patterncraft-css-adapter.png") });

	await page.getByTestId("open-library").click();
	await expect(page.getByTestId("wallpaper-catalog-count")).toHaveText(
		"2 of 2 wallpapers"
	);
	await expect(
		page.getByTestId(`wallpaper-catalog-card-${patternId}`)
	).toBeVisible();
	await page
		.getByTestId("product-page")
		.screenshot({ path: path.join(PROOF_DIR, "library-wallpapers-tab.png") });
	await page
		.getByTestId(`wallpaper-catalog-card-${patternId}`)
		.getByRole("button", { name: "Use wallpaper" })
		.click();
	await expect(page.getByTestId("active-wallpaper-id")).toHaveText(
		`backdrop:${patternId}`
	);

	await page
		.getByTestId(`wallpaper-catalog-card-${patternId}`)
		.getByRole("button", { name: "Remove" })
		.click();
	await page
		.getByTestId(`wallpaper-catalog-card-${MESH_GRADIENT_ID}`)
		.getByRole("button", { name: "Remove" })
		.click();
	await expect(page.getByText("No wallpapers installed yet")).toBeVisible();
	await page.getByRole("button", { name: "Browse Wallpapers" }).click();
	await expect(page.getByTestId("wallpaper-marketplace-section")).toBeVisible();
	await expect(page.getByTestId("wallpaper-catalog-count")).toHaveText(
		"260 of 260 wallpapers"
	);
});
