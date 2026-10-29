import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
	Command,
	CommandEmpty,
	CommandList,
	CommandLoading,
} from "./command.tsx";

describe("Command list states", () => {
	test("CommandLoading is a labelled progressbar that hides its skeleton", () => {
		const html = renderToStaticMarkup(
			<Command>
				<CommandList>
					<CommandLoading label="Loading branches">
						<span role="status">rows</span>
					</CommandLoading>
				</CommandList>
			</Command>
		);
		expect(html).toContain('data-slot="command-loading"');
		expect(html).toContain('role="progressbar"');
		expect(html).toContain('aria-label="Loading branches"');
		// cmdk wraps children in an aria-hidden div, so the listbox does not own
		// a nested status region.
		expect(html).toMatch(/<div aria-hidden="true"><span role="status">/);
	});

	test("CommandLoading defaults its accessible name to Loading", () => {
		const html = renderToStaticMarkup(
			<Command>
				<CommandList>
					<CommandLoading />
				</CommandList>
			</Command>
		);
		expect(html).toContain('aria-label="Loading"');
	});

	test("CommandEmpty renders as presentation when the list has no items", () => {
		const html = renderToStaticMarkup(
			<Command shouldFilter={false}>
				<CommandList>
					<CommandEmpty>No branches found.</CommandEmpty>
				</CommandList>
			</Command>
		);
		expect(html).toContain('data-slot="command-empty"');
		expect(html).toContain('role="presentation"');
		expect(html).toContain("No branches found.");
	});
});
