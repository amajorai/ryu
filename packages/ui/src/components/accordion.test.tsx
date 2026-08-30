import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "./accordion.tsx";

test("allows panel and content padding to be removed independently", () => {
	const html = renderToStaticMarkup(
		<Accordion defaultValue={["options"]}>
			<AccordionItem value="options">
				<AccordionTrigger>Options</AccordionTrigger>
				<AccordionContent className="p-0" panelClassName="p-0">
					Content
				</AccordionContent>
			</AccordionItem>
		</Accordion>
	);

	expect(html).toMatch(
		/data-slot="accordion-content"[^>]*class="[^"]*p-0[^"]*"/
	);
	expect(html).toMatch(
		/data-slot="accordion-content"[\s\S]*<div class="[^"]*p-0[^"]*">Content<\/div>/
	);
});
