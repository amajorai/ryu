import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NotificationStack } from "./notification-stack.tsx";

const ACCENT_VARIABLE = "--notification-stack-1-border-left-color";

function moduleRule(css: string, selector: string): string {
	const start = css.indexOf(`${selector} {`);
	return start === -1 ? "" : css.slice(start, css.indexOf("}", start));
}

describe("NotificationStack", () => {
	it("sets the accent color only on cards that carry an accent", () => {
		const html = renderToStaticMarkup(
			<NotificationStack
				defaultExpanded
				items={[
					{ accent: "var(--destructive)", id: "risky", title: "Risky" },
					{ id: "plain", title: "Plain" },
				]}
			/>
		);

		expect(html.split(ACCENT_VARIABLE).length - 1).toBe(1);
		expect(html.split("border-border/60").length - 1).toBe(2);
	});

	it("keeps the accent edge out of the always-applied card rule", async () => {
		// CSS modules are unlayered and outrank `border-border/60`. An always-on
		// rule reading an unset accent variable would paint plain cards' left edge
		// in currentColor, so the accent lives in its own conditional class.
		const css = await Bun.file(
			new URL("./notification-stack.drawing.module.css", import.meta.url)
		).text();
		const card = moduleRule(css, ".notificationCard");
		const accent = moduleRule(css, ".notificationAccent");

		expect(card).toContain("grid-row");
		expect(card).not.toContain("border-left");
		expect(accent).toContain(`border-left-color: var(${ACCENT_VARIABLE})`);
	});
});
