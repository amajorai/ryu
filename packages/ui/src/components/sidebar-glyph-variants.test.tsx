import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AppIconArtwork from "./app-icon-artwork.tsx";
import type { GlyphValue } from "./glyph.ts";
import { GlyphDisplay } from "./glyph-display.tsx";
import { Icon } from "./icon.tsx";
import { Logo } from "./logo.tsx";
import { Spinner } from "./spinner.tsx";

function markup(element: ReactElement) {
	return renderToStaticMarkup(element).replace(
		/class="([^"]*)"/g,
		(_, classes: string) => `class="${classes.split(" ").sort().join(" ")}"`
	);
}
const glyphs = [
	{ kind: "avatar", dataUrl: "data:image/png;base64,YQ==" },
	{ kind: "icon", id: "lucide:heart" },
	{ kind: "emoji", emoji: "🙂" },
	{ kind: "dicebear", style: "bottts", seed: "fixture" },
	{ kind: "expressive", expression: "neutral", animated: false },
	{ kind: "dither", dither: { direction: "up", from: "grey", to: null } },
	null,
] satisfies GlyphValue[];

describe("sidebar glyph owner variants", () => {
	test("muted tone and circle corners preserve every glyph branch", () => {
		for (const value of glyphs) {
			expect(
				markup(<GlyphDisplay animated={false} tone="muted" value={value} />)
			).toBe(
				markup(
					<GlyphDisplay
						animated={false}
						className="text-muted-foreground"
						value={value}
					/>
				)
			);
			expect(
				markup(<GlyphDisplay animated={false} corners="circle" value={value} />)
			).toBe(
				markup(
					<GlyphDisplay
						animated={false}
						className="rounded-full object-cover"
						value={value}
					/>
				)
			);
		}
	});
	test("compact corners preserve glyph classes and layered artwork", () => {
		for (const value of glyphs) {
			expect(
				markup(
					<GlyphDisplay animated={false} corners="compact" value={value} />
				)
			).toBe(
				markup(
					<GlyphDisplay
						animated={false}
						className="rounded-glyph-compact object-contain"
						value={value}
					/>
				)
			);
		}
		expect(markup(<AppIconArtwork corners="compact" id="@ryu/browser" />)).toBe(
			markup(
				<AppIconArtwork className="rounded-artwork-compact" id="@ryu/browser" />
			)
		);
	});
	test("inherited corners retain final-owner precedence over caller radius and fit", () => {
		for (const value of glyphs) {
			const inherited = markup(
				<GlyphDisplay
					animated={false}
					className="rounded-full object-contain"
					corners="inherit"
					value={value}
				/>
			);
			const expected = markup(
				<GlyphDisplay
					animated={false}
					className="rounded-inherit object-cover"
					value={value}
				/>
			);
			expect(inherited).toBe(expected);
		}
	});
	test("icon visibility and motion reproduce the existing row states", () => {
		expect(
			markup(
				<Icon
					icon="lucide:heart"
					motion="opacity"
					tone="muted"
					visibility="concealed"
				/>
			)
		).toBe(
			markup(
				<Icon
					className="text-muted-foreground opacity-0 transition-opacity"
					icon="lucide:heart"
				/>
			)
		);
		expect(
			markup(
				<Icon
					icon="lucide:heart"
					motion="opacity"
					tone="muted"
					visibility="row-hover"
				/>
			)
		).toBe(
			markup(
				<Icon
					className="text-muted-foreground opacity-100 transition-opacity group-hover/row:opacity-0 group-focus-visible/row:opacity-0 group-has-[button:focus-visible]/row:opacity-0"
					icon="lucide:heart"
				/>
			)
		);
		expect(markup(<Icon icon="lucide:heart" />)).not.toContain('class=""');
	});
	test("sidebar spinner retains its existing effect classes and SVG attributes", () => {
		expect(markup(<Spinner presentation="sidebar-tab" />)).toBe(
			markup(
				<Spinner className="transition-[scale,opacity] duration-150 group-hover/row:scale-50 group-hover/row:opacity-0 group-focus-visible/row:scale-50 group-focus-visible/row:opacity-0 group-has-[button:focus-visible]/row:scale-50 group-has-[button:focus-visible]/row:opacity-0" />
			)
		);
	});
	test("logo owner presentation preserves static and expressive roots", () => {
		for (const variant of [
			"outline-static",
			"expressive",
			"default",
		] satisfies Array<"outline-static" | "expressive" | "default">) {
			for (const corners of ["circle", "compact"] satisfies Array<
				"circle" | "compact"
			>) {
				const cornerClasses =
					corners === "circle"
						? "rounded-full object-cover"
						: "rounded-glyph-compact object-contain";
				expect(
					markup(
						<Logo
							animated={false}
							corners={corners}
							presentation="sidebar-tab"
							variant={variant}
						/>
					)
				).toBe(
					markup(
						<Logo
							animated={false}
							className={`${cornerClasses} transition-[scale,opacity] duration-150 group-hover/row:scale-50 group-hover/row:opacity-0 group-focus-visible/row:scale-50 group-focus-visible/row:opacity-0 group-has-[button:focus-visible]/row:scale-50 group-has-[button:focus-visible]/row:opacity-0`}
							variant={variant}
						/>
					)
				);
			}
		}
	});
});
