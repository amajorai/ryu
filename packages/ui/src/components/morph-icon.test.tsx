import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MorphIconSwap } from "./morph-icon.tsx";

const horizontal = [["path", { d: "M3 12h18" }]] as const;
const vertical = [["path", { d: "M12 3v18" }]] as const;

describe("MorphIconSwap", () => {
	test("renders the selected icon data with decorative accessibility defaults", () => {
		const markup = renderToStaticMarkup(
			<MorphIconSwap a={horizontal} b={vertical} className="size-4" state="b" />
		);

		expect(markup).toContain('aria-hidden="true"');
		expect(markup).toContain('class="shrink-0 size-4"');
		expect(markup).toContain('d="M12 3C12 9 12 15 12 21"');
		expect(markup).not.toContain('d="M3 12C9 12 15 12 21 12"');
	});

	test("supports an accessible label when the icon carries meaning", () => {
		const markup = renderToStaticMarkup(
			<MorphIconSwap
				a={horizontal}
				b={vertical}
				label="Expand details"
				state="a"
			/>
		);

		expect(markup).toContain('role="img"');
		expect(markup).toContain("<title>Expand details</title>");
		expect(markup).toContain('d="M3 12C9 12 15 12 21 12"');
	});
});
