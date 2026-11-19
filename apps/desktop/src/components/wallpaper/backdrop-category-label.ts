import type { LiteralMessage } from "@ryu/i18n/react";

/**
 * A backdrop category tab's (or Marketplace category chip's) label. Every
 * category id from `BACKDROP_CATEGORIES` is declared as a whole `tl()` message
 * so the extractor catalogs it ("Decorative", "Shader library"). "Light" and
 * "Space" are stable ids whose bare word translates in the wrong sense
 * (brightness, a region), so their tabs say what they hold. An unknown
 * category (a plugin's own) is returned as written.
 */
export function backdropCategoryLabel(
	category: string,
	tl: LiteralMessage
): string {
	switch (category) {
		case "All":
			return tl("All");
		case "All categories":
			return tl("All categories");
		case "Marketplace":
			return tl("Marketplace");
		case "Gradients":
			return tl("Gradients");
		case "Light":
			return tl("Light effects");
		case "Liquid":
			return tl("Liquid");
		case "Space":
			return tl("Outer space");
		case "Patterns":
			return tl("Patterns");
		case "Geometric":
			return tl("Geometric");
		case "Decorative":
			return tl("Decorative");
		case "Effects":
			return tl("Effects");
		case "Shader library":
			return tl("Shader library");
		case "Custom":
			return tl("Custom");
		default:
			return category;
	}
}
