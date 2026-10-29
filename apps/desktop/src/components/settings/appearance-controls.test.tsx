import { expect, it } from "bun:test";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible.tsx";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import archivedControls from "./appearance-controls.fixture.json" with {
	type: "json",
};

const controls = z
	.object({
		buttons: z.array(
			z.object({
				variant: z.enum(["default", "ghost", "destructive"]),
				dense: z.boolean(),
				disabled: z.boolean(),
				markup: z.string(),
			})
		),
		collapsibles: z.array(z.object({ open: z.boolean(), markup: z.string() })),
	})
	.parse(archivedControls);
// The archived markup predates the squircle removal; retired corner-shape
// utilities are the only tokens the shared primitives dropped since.
const RETIRED_CORNER_UTILITY =
	/(?:^|:)corner-(?:[a-z]{1,2}-)?(?:squircle|round)$/;

function normalizeUtilityOrder(markup: string) {
	return markup.replace(
		/class="([^"]*)"/g,
		(_attribute, classes: string) =>
			`class="${[...new Set(classes.split(" "))]
				.filter((value) => !RETIRED_CORNER_UTILITY.test(value))
				.sort()
				.join(" ")}"`
	);
}
it("preserves original preset action typography, padding, native SVG size and disabled markup", () => {
	for (const { variant, dense, disabled, markup } of controls.buttons) {
		const current = renderToStaticMarkup(
			<Button
				disabled={disabled}
				size={dense ? "dense" : "compact"}
				variant={variant}
			>
				<svg aria-hidden="true">
					<path d="M0 0" />
				</svg>
				Action
			</Button>
		);
		expect(normalizeUtilityOrder(current)).toBe(normalizeUtilityOrder(markup));
	}
});
it("preserves native advanced-detail disclosure state and panel markup", () => {
	for (const { open, markup } of controls.collapsibles) {
		const current = renderToStaticMarkup(
			<Collapsible open={open}>
				<CollapsibleTrigger
					appearance="settings-detail"
					className="flex w-full items-center justify-between text-left"
				>
					Advanced detail
				</CollapsibleTrigger>
				<CollapsibleContent spacing="settings-detail">
					Details
				</CollapsibleContent>
			</Collapsible>
		);
		expect(normalizeUtilityOrder(current)).toBe(normalizeUtilityOrder(markup));
	}
});
