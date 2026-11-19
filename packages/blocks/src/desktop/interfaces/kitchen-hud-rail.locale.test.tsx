// The order rail's list is named for the kitchen's order tickets. The bare
// "Tickets" row of the catalog is the support queue, so the rail reads
// through its own sense id.
import { expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { usefulStateFixture } from "./game-acts-fixture.ts";
import { OrderRail } from "./kitchen-hud-rail.tsx";
import { toTicket } from "./kitchen-model.ts";
import { EMPTY_THEME, kitchenPalette } from "./kitchen-palette.ts";

const SNAPSHOT = usefulStateFixture();
const THREAD = SNAPSHOT.threads[0];
if (!THREAD) {
	throw new Error("the fixture has no threads");
}
const TICKET = toTicket(SNAPSHOT, THREAD);

/** Stand-ins for the support-queue sense of the bare catalog row. */
const OVERLAYS = {
	de: { Tickets: "Tickets" },
	ja: { Tickets: "チケット" },
};

function railLabel(locale: string): string | undefined {
	const html = renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			manageDocument={false}
			overlays={OVERLAYS}
		>
			<OrderRail
				activeThreadId={null}
				density="wide"
				hoverId={null}
				loading={false}
				onHover={() => undefined}
				onServe={() => undefined}
				palette={kitchenPalette(EMPTY_THEME)}
				service={{
					dishes: [],
					dishOverflow: 0,
					floor: { depth: 1, pass: { length: 1, x: 0, z: 0 }, width: 1 },
					rail: [TICKET],
					stations: [],
					totals: {
						burnt: 0,
						cooking: 0,
						queued: 1,
						ready: 0,
						servedToday: 0,
					},
				}}
			/>
		</I18nProvider>
	);
	return /<ol aria-label="([^"]*)"/u.exec(html)?.[1];
}

test("the Japanese rail names its order slips 伝票", () => {
	expect(railLabel("ja")).toBe("伝票");
});

test("the German and Arabic rails use the order-ticket word", () => {
	expect(railLabel("de")).toBe("Bons");
	expect(railLabel("ar")).toBe("بطاقات الطلب");
});

test("the English rail keeps the Tickets label", () => {
	expect(railLabel("en")).toBe("Tickets");
});
