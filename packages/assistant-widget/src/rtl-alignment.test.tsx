import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { PageToolForm } from "./page-tools-form.tsx";
import { RuntimeSettingsMenu } from "./runtime-controls.tsx";
import { RyuAssistantRecentChats } from "./surface.tsx";

const noop = () => undefined;
const PHYSICAL_TEXT_ALIGN = /\btext-(?:left|right)\b(?!-)/u;
const SOURCE_FILE = /^(?!.*\.test\.)[\w.-]+\.tsx?$/u;

describe("assistant widget right-to-left alignment", () => {
	test("aligns recent-chat rows to the reading start", () => {
		const html = renderToStaticMarkup(
			<div dir="rtl">
				<RyuAssistantRecentChats
					items={[{ id: "chat-1", meta: "1m", title: "محادثة" }]}
					onSelect={noop}
				/>
			</div>
		);

		expect(html).toContain("text-start");
		expect(html).not.toMatch(PHYSICAL_TEXT_ALIGN);
	});

	test("aligns runtime menu rows to the reading start", () => {
		const html = renderToStaticMarkup(
			<RuntimeSettingsMenu
				busy={false}
				guestAvailable
				mode="guest"
				nodeConnected={false}
				onDisconnect={noop}
				onModeChange={noop}
			/>
		);

		expect(html).toContain("text-start");
		expect(html).not.toMatch(PHYSICAL_TEXT_ALIGN);
	});

	test("mirrors the page-tool back arrow and labels a tool without an origin", () => {
		const html = renderToStaticMarkup(
			<PageToolForm
				onBack={noop}
				onExecute={async () => "ok"}
				onResult={noop}
				tool={{
					id: "local\u0000read_page\u00000",
					description: "Read the current page.",
					inputSchema: {
						additionalProperties: false,
						properties: {},
						type: "object",
					},
					name: "read_page",
					title: "Read a page",
				}}
			/>
		);

		expect(html).toContain("rtl:-scale-x-100");
		expect(html).toContain("read_page · Current page");
	});

	test("ships no physical text alignment in widget source", () => {
		const offenders = readdirSync(import.meta.dir)
			.filter((name) => SOURCE_FILE.test(name))
			.filter((name) =>
				PHYSICAL_TEXT_ALIGN.test(
					readFileSync(join(import.meta.dir, name), "utf8")
				)
			);

		expect(offenders).toEqual([]);
	});
});
