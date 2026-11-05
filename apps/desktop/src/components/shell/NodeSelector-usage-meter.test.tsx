import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { UsageMeter } from "./NodeSelector-usage-meter.tsx";

const shown = (html: string) =>
	html
		.slice(html.lastIndexOf('<span class="tabular-nums">'))
		.replace(/<[^>]+>/gu, "");

describe("UsageMeter", () => {
	test("prints the usage share in the viewer's number format", () => {
		expect(
			shown(renderToStaticMarkup(<UsageMeter locale="en" percent={42} />))
		).toBe("42%");
		expect(
			shown(renderToStaticMarkup(<UsageMeter locale="de" percent={42} />))
		).toBe(`42${String.fromCodePoint(0xa0)}%`);
		expect(
			shown(renderToStaticMarkup(<UsageMeter locale="ar" percent={42} />))
		).toBe(new Intl.NumberFormat("ar", { style: "percent" }).format(0.42));
	});
});
