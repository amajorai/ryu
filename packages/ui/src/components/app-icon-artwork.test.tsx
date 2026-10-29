import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import AppIconArtwork, { composerIconFor } from "./app-icon-artwork.tsx";

test("manifest and public catalog IDs render identical native artwork on the server", () => {
	const native = renderToStaticMarkup(
		<AppIconArtwork id="@ryu/browser" size={64} />
	);
	const publicCatalog = renderToStaticMarkup(
		<AppIconArtwork id="ryu/browser" size={64} />
	);
	expect(publicCatalog).toBe(native);
	expect(native).toContain('data-app-icon="layered"');
	expect(native).not.toMatch(/mask-image|background-image|border-radius/);
	expect([...native.matchAll(/<img /g)]).toHaveLength(2);
});

test("unknown and inherited object names preserve caller artwork", () => {
	for (const id of ["@custom/app", "constructor", "__proto__", null]) {
		expect(composerIconFor(id)).toBeNull();
		expect(
			renderToStaticMarkup(
				<AppIconArtwork fallback={<span>Custom artwork</span>} id={id} />
			)
		).toBe("<span>Custom artwork</span>");
	}
});
