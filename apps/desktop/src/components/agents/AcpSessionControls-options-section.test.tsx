import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AcpOptionRow } from "./AcpSessionControls-options-section.tsx";

// The closed select shows the agent-advertised option name. A bare
// <SelectValue /> without `items` printed the option id ("acceptEdits").

describe("AcpOptionRow select trigger", () => {
	test("shows the advertised name of the selected option", () => {
		const html = renderToStaticMarkup(
			<AcpOptionRow
				section={{
					ariaLabel: "Approval mode",
					items: [
						{ id: "default", name: "Ask every time" },
						{ id: "acceptEdits", name: "Accept edits" },
					],
					key: "mode",
					label: "Approval mode",
					onChange: () => undefined,
					value: "acceptEdits",
				}}
			/>
		);
		const trigger = html.slice(
			html.indexOf('data-slot="select-trigger"'),
			html.indexOf("</button>")
		);
		expect(trigger).toContain("Accept edits");
		expect(trigger).not.toContain("acceptEdits");
	});
});
