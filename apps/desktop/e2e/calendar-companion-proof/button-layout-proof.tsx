import { RyuAppShell } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/ui/components/button.tsx";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import "./button-layout-proof.css";

const root = document.getElementById("button-root");
if (!root) {
	throw new Error("Shared Button proof is missing #button-root");
}

createRoot(root).render(
	createElement(
		RyuAppShell,
		{ style: { alignItems: "flex-start", padding: 16 } },
		createElement(
			"div",
			{ style: { width: 180 } },
			createElement(
				Button,
				{
					"aria-label": "Calendar day cell",
					className: "flex min-h-[104px] w-full flex-col gap-1 text-left",
				},
				createElement(
					"div",
					{ className: "flex flex-col gap-0.5" },
					createElement(
						Button,
						{
							className:
								"flex w-full items-center gap-1 truncate rounded-sm px-1 py-0.5 text-left type-caption leading-tight",
							type: "button",
						},
						createElement(
							"span",
							{ className: "shrink-0 font-medium tabular-nums" },
							"08:00 PM"
						),
						createElement(
							"span",
							{ className: "truncate" },
							"Quarterly compliance report with an exceptionally long title"
						)
					)
				)
			)
		)
	)
);

document.body.setAttribute("data-button-layout-proof-ready", "1");
