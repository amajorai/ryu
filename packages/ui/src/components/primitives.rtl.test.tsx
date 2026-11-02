import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "./accordion.tsx";
import { AgentCode } from "./agents/agent-code.tsx";
import { CodeBlock } from "./agents/code-block.tsx";
import { FileDiff } from "./agents/file-diff.tsx";
import {
	Bubble,
	BubbleContent,
	BubbleGroup,
	BubbleReactions,
} from "./bubble.tsx";
import { ButtonGroup } from "./button-group.tsx";
import { buttonVariants } from "./button-variants.ts";
import { DirectionProvider } from "./direction.tsx";
import {
	FadeOverflowText,
	fadeOverflowMarqueeKeyframes,
} from "./fade-overflow-text.tsx";
import { FieldDescription } from "./field.tsx";
import { Input } from "./input.tsx";
import { ItemDescription } from "./item.tsx";
import { Input as MotionInput } from "./motion/input.tsx";
import { NativeSelect, NativeSelectOption } from "./native-select.tsx";
import { PageHeader } from "./page-header.tsx";
import { ScrollArea, ScrollBar } from "./scroll-area.tsx";
import { SidebarProvider } from "./sidebar.tsx";
import {
	SidebarMenu,
	SidebarMenuAction,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
} from "./sidebar-menu.tsx";
import { Switch } from "./switch.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./table.tsx";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group.tsx";

function classesOf(html: string, slot: string): string[] {
	const tag = html.match(new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`))?.[0];
	if (!tag) {
		throw new Error(`no ${slot} in markup`);
	}
	return (tag.match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
}

function rtl(tree: ReactElement): string {
	return renderToStaticMarkup(
		<DirectionProvider direction="rtl">
			<div dir="rtl">{tree}</div>
		</DirectionProvider>
	);
}

/** Physical inline utilities that do not flip under `dir="rtl"`. */
const PHYSICAL_INLINE =
	/^(?:.*:)?-?(?:left|right)-|(?:^|:)!?border-[lr](?:-|$)|(?:^|:)!?-?[mp][lr]-|(?:^|:)!?rounded-(?:[lr]|[tb][lr])(?:-|$)|(?:^|:)text-(?:left|right)$/;

function physical(classes: string[]): string[] {
	return classes.filter((name) => PHYSICAL_INLINE.test(name));
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every class token in a rendered tree. */
function allClasses(html: string): string[] {
	return [...html.matchAll(/class="([^"]*)"/g)].flatMap((match) =>
		(match[1] ?? "").split(/\s+/)
	);
}

describe("@ryu/ui primitives in a right-to-left layout", () => {
	test("sidebar menu action, badge and sub-tree use logical sides", () => {
		const html = rtl(
			<SidebarProvider>
				<SidebarMenu nestedIndent>
					<SidebarMenuItem>
						<SidebarMenuButton>Inbox</SidebarMenuButton>
						<SidebarMenuAction>+</SidebarMenuAction>
						<SidebarMenuBadge>3</SidebarMenuBadge>
						<SidebarMenuSub>
							<SidebarMenuSubItem>
								<SidebarMenuSubButton href="#a">Child</SidebarMenuSubButton>
							</SidebarMenuSubItem>
						</SidebarMenuSub>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarProvider>
		);
		const menu = classesOf(html, "sidebar-menu");
		expect(menu).toContain("ps-5");
		const button = classesOf(html, "sidebar-menu-button");
		expect(button).toContain("text-start");
		expect(button).toContain(
			"group-has-data-[sidebar=menu-action]/menu-item:pe-8"
		);
		expect(button).toContain(
			"group-has-data-[sidebar=menu-badge]/menu-item:pe-8"
		);
		expect(classesOf(html, "sidebar-menu-action")).toContain("end-1");
		expect(classesOf(html, "sidebar-menu-badge")).toContain("end-1");
		const sub = classesOf(html, "sidebar-menu-sub");
		expect(sub).toContain("border-s");
		expect(sub).toContain("rtl:-translate-x-px");
		expect(classesOf(html, "sidebar-menu-sub-button")).toContain(
			"rtl:translate-x-px"
		);
		for (const slot of [
			"sidebar-menu",
			"sidebar-menu-button",
			"sidebar-menu-action",
			"sidebar-menu-badge",
			"sidebar-menu-sub",
			"sidebar-menu-sub-button",
		]) {
			expect(physical(classesOf(html, slot))).toEqual([]);
		}
	});

	test("input adornments reserve logical padding", () => {
		const leading = classesOf(
			rtl(<Input leadingAdornment="default" />),
			"input"
		);
		expect(leading).toContain("ps-9");
		const trailing = classesOf(
			rtl(<Input trailingAdornment="password-toggle" />),
			"input"
		);
		expect(trailing).toContain("pe-14");
		for (const variant of ["search-icon", "compact", "default"] as const) {
			expect(
				physical(classesOf(rtl(<Input leadingAdornment={variant} />), "input"))
			).toEqual([]);
		}
		expect(
			physical(classesOf(rtl(<Input variant="blog-search" />), "input"))
		).toEqual([]);
		expect(
			physical(classesOf(rtl(<Input purpose="picker-filter" />), "input"))
		).toEqual([]);
	});

	test("table headers start-align and the end inset is logical", () => {
		const html = rtl(
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead inset="end">Name</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					<TableRow>
						<TableCell inset="end" presentation="usage-counter">
							1
						</TableCell>
					</TableRow>
				</TableBody>
			</Table>
		);
		const head = classesOf(html, "table-head");
		expect(head).toContain("text-start");
		expect(head).toContain("pe-6");
		expect(physical(head)).toEqual([]);
		const cell = classesOf(html, "table-cell");
		expect(cell).toContain("text-end");
		expect(physical(cell)).toEqual([]);
	});

	test("native select pads and pins its chevron logically", () => {
		const html = rtl(
			<NativeSelect>
				<NativeSelectOption value="a">A</NativeSelectOption>
			</NativeSelect>
		);
		const select = classesOf(html, "native-select");
		expect(select).toContain("ps-3");
		expect(select).toContain("pe-8");
		expect(physical(select)).toEqual([]);
		const icon = classesOf(html, "native-select-icon");
		expect(icon).toContain("end-2.5");
		expect(physical(icon)).toEqual([]);
	});

	test("code, agent code and diff viewports stay left to right", () => {
		const preTag = (html: string) => html.match(/<pre[^>]*>/)?.[0] ?? "";
		const code = preTag(rtl(<AgentCode code="const a = 1;" />));
		expect(code).toContain('dir="ltr"');
		expect(code).toContain("text-start");

		const block = rtl(<CodeBlock code={"const a = 1;\nconst b = 2;"} />);
		expect(preTag(block)).toContain('dir="ltr"');
		expect(preTag(block)).toContain("text-start");

		const diff = rtl(
			<FileDiff
				defaultOpen
				file="src/a.ts"
				lines={[
					{ content: "const a = 1;", id: "1", newLine: 1, type: "added" },
				]}
				status="complete"
			/>
		);
		const viewport =
			diff.match(/<div[^>]*data-slot="file-diff-viewport"[^>]*>/)?.[0] ?? "";
		expect(viewport).toContain('dir="ltr"');
		expect(diff).toContain("ps-6");
		expect(diff).not.toContain("pl-6");
	});

	test("text primitives align to the inline start, not the left", () => {
		const html = rtl(
			<>
				<PageHeader size="app" subtitle="Subtitle" title="Title" />
				<FieldDescription>Help</FieldDescription>
				<ItemDescription>Detail</ItemDescription>
				<Accordion>
					<AccordionItem value="one">
						<AccordionTrigger>Question</AccordionTrigger>
						<AccordionContent>Answer</AccordionContent>
					</AccordionItem>
				</Accordion>
			</>
		);
		const classes = allClasses(html);
		expect(physical(classes)).toEqual([]);
		expect(classes).toContain("text-start");
		expect(classesOf(html, "field-description")).toContain("text-start");
		expect(classesOf(html, "item-description")).toContain("text-start");
		expect(classesOf(html, "accordion-trigger")).toContain("text-start");
	});

	test("list-style button appearances use logical alignment and padding", () => {
		for (const appearance of [
			"composer-mode",
			"question-option",
			"agent-model-option",
			"account-menu-sidebar",
		] as const) {
			const classes = buttonVariants({ appearance }).split(/\s+/);
			expect(physical(classes)).toEqual([]);
			expect(classes).toContain("text-start");
		}
		const joined = buttonVariants({ edge: "joined" }).split(/\s+/);
		expect(joined).toContain("border-e-0");
	});

	test("joined groups, bubbles, scrollbars and the motion input use logical sides", () => {
		const html = rtl(
			<>
				<ButtonGroup>
					<button type="button">One</button>
					<button type="button">Two</button>
				</ButtonGroup>
				<ToggleGroup spacing={0} variant="outline">
					<ToggleGroupItem value="a">A</ToggleGroupItem>
					<ToggleGroupItem value="b">B</ToggleGroupItem>
				</ToggleGroup>
				<BubbleGroup>
					{(
						[
							"start-first",
							"start-middle",
							"start-last",
							"end-first",
							"end-middle",
							"end-last",
						] as const
					).map((corner) => (
						<Bubble
							align={corner.startsWith("end") ? "end" : "start"}
							key={corner}
						>
							<BubbleContent corner={corner}>{corner}</BubbleContent>
							<BubbleReactions align="start">+1</BubbleReactions>
						</Bubble>
					))}
				</BubbleGroup>
				<ScrollArea>
					Body
					<ScrollBar keepMounted />
				</ScrollArea>
				<MotionInput leftIcon={<span>L</span>} rightIcon={<span>R</span>} />
				<MotionInput success />
			</>
		);
		const classes = allClasses(html);
		expect(physical(classes)).toEqual([]);
		expect(classesOf(html, "toggle-group-item")).toContain(
			"group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-s-3xl"
		);
		expect(classes).toContain("rounded-es-md");
		expect(classes).toContain("rounded-se-md");
		expect(classes).toContain("start-3");
		expect(classes).toContain("ps-10");
		expect(classes).toContain("pe-10");
		expect(classes).toContain("end-3.5");
		expect(classesOf(html, "scroll-area-scrollbar")).toContain(
			"data-vertical:border-s"
		);
	});

	test("the base rule keeps code LTR but lets an explicit dir attribute win", () => {
		const css = readFileSync(
			new URL("../styles/globals/base.css", import.meta.url),
			"utf8"
		);
		const rule = css.match(/:where\(pre, code, kbd, samp\)[^{]*\{[^}]*\}/)?.[0];
		expect(rule).toContain(":where(:not([dir]))");
		expect(rule).toContain("direction: ltr;");
		expect(rule).toContain("unicode-bidi: isolate;");
	});

	test("the switch thumb travels toward the inline end, checked and unchecked", () => {
		const css = readFileSync(
			new URL("../styles/globals/transitions.css", import.meta.url),
			"utf8"
		);
		const scope = '.t-toggle:where([dir="rtl"], [dir="rtl"] *)';
		const unchecked = css.match(
			new RegExp(`${escapeRegExp(scope)} \\.t-toggle-thumb \\{[^}]*\\}`)
		)?.[0];
		const checked = css.match(
			new RegExp(
				`${escapeRegExp(scope)}\\[data-checked\\] \\.t-toggle-thumb \\{[^}]*\\}`
			)
		)?.[0];
		expect(unchecked).toContain("transform-origin: right center;");
		expect(checked).toContain("transform-origin: left center;");
		expect(checked).toContain("translate: calc(var(--toggle-travel) * -1) 0;");
		// The RTL rules follow the physical ones so they win at equal specificity.
		expect(css.indexOf(scope)).toBeGreaterThan(
			css.indexOf(".t-toggle[data-checked] .t-toggle-thumb")
		);

		for (const defaultChecked of [false, true]) {
			const html = rtl(
				<Switch aria-label="Notify me" defaultChecked={defaultChecked} />
			);
			const state = defaultChecked ? "data-checked" : "data-unchecked";
			expect(html).toMatch(
				new RegExp(
					`<[^>]*data-slot="switch-thumb"[^>]*${state}|<[^>]*${state}[^>]*data-slot="switch-thumb"`
				)
			);
			expect(classesOf(html, "switch")).toContain("t-toggle");
			expect(classesOf(html, "switch-thumb")).toContain("t-toggle-thumb");
			expect(physical(allClasses(html))).toEqual([]);
		}
	});

	test("clipped labels fade and scroll toward the inline end", () => {
		const utilities = readFileSync(
			new URL("../styles/globals/theme-utilities.css", import.meta.url),
			"utf8"
		);
		const utility = utilities.slice(
			utilities.indexOf("@utility fade-text-edge"),
			utilities.indexOf("@utility scrim-t")
		);
		expect(utility).toContain("to right,");
		expect(utility).toContain('&:where([dir="rtl"], [dir="rtl"] *)');
		expect(utility).toContain("to left,");

		const ltr = fadeOverflowMarqueeKeyframes(40, "ltr");
		const rtlFrames = fadeOverflowMarqueeKeyframes(40, "rtl");
		expect(ltr.at(-1)?.transform).toBe("translateX(-40px)");
		expect(rtlFrames.at(-1)?.transform).toBe("translateX(40px)");
		expect(rtlFrames.at(-2)?.transform).toBe("translateX(40px)");
		expect(rtlFrames[0]?.transform).toBe("translateX(0)");

		const html = rtl(
			<FadeOverflowText data-slot="fade-label">طويل جدا</FadeOverflowText>
		);
		expect(physical(classesOf(html, "fade-label"))).toEqual([]);
	});
});
