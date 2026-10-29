import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type CommandVariantLatch,
	nextCommandVariantLatch,
	resolveCommandVariant,
} from "./command-variant.ts";

interface CapturedDrawer {
	content: Record<string, unknown>;
	root: Record<string, unknown>;
}

const captured: CapturedDrawer = { root: {}, content: {} };

mock.module("@ryu/ui/components/drawer.tsx", () => ({
	Drawer: ({
		children,
		...props
	}: { children?: React.ReactNode } & Record<string, unknown>) => {
		captured.root = props;
		return <div data-testid="drawer">{children}</div>;
	},
	DrawerContent: ({
		children,
		...props
	}: { children?: React.ReactNode } & Record<string, unknown>) => {
		captured.content = props;
		return <div>{children}</div>;
	},
	DrawerDescription: ({ children }: { children?: React.ReactNode }) => (
		<p>{children}</p>
	),
	DrawerTitle: ({ children }: { children?: React.ReactNode }) => (
		<h2>{children}</h2>
	),
}));

const { CommandDialog } = await import("./command.tsx");

const originalMatchMedia = globalThis.window?.matchMedia;
const hadWindow = globalThis.window !== undefined;

beforeAll(() => {
	const mobileMatchMedia = (query: string) =>
		({
			matches: true,
			media: query,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		}) as unknown as MediaQueryList;
	if (hadWindow) {
		globalThis.window.matchMedia = mobileMatchMedia;
	} else {
		(globalThis as { window?: unknown }).window = {
			matchMedia: mobileMatchMedia,
		};
	}
});

afterAll(() => {
	if (!hadWindow) {
		(globalThis as { window?: unknown }).window = undefined;
		return;
	}
	if (originalMatchMedia) {
		globalThis.window.matchMedia = originalMatchMedia;
	}
});

describe("CommandDialog on mobile", () => {
	test("renders a drawer and forwards modal and className", () => {
		const html = renderToStaticMarkup(
			<CommandDialog className="sm:max-w-lg" modal={false} open>
				<span>body</span>
			</CommandDialog>
		);
		expect(html).toContain('data-testid="drawer"');
		expect(captured.root.modal).toBe(false);
		expect(captured.root.open).toBe(true);
		expect(String(captured.content.className).split(" ")).toEqual(
			expect.arrayContaining(["p-2", "pt-0", "sm:max-w-lg"])
		);
	});

	test("keeps the drawer modal for trap-focus and leaves it unset by default", () => {
		renderToStaticMarkup(
			<CommandDialog modal="trap-focus">
				<span>body</span>
			</CommandDialog>
		);
		expect(captured.root.modal).toBe(true);
		renderToStaticMarkup(
			<CommandDialog>
				<span>body</span>
			</CommandDialog>
		);
		expect(captured.root.modal).toBeUndefined();
	});
});

describe("CommandDialog variant latch", () => {
	const closedDesktop: CommandVariantLatch = { mobile: false, open: false };

	test("follows the viewport while closed and on the opening render", () => {
		expect(resolveCommandVariant(closedDesktop, false, true)).toBe(true);
		expect(resolveCommandVariant(closedDesktop, true, true)).toBe(true);
		expect(nextCommandVariantLatch(closedDesktop, true, true)).toEqual({
			mobile: true,
			open: true,
		});
	});

	test("keeps the opened variant when the viewport crosses the breakpoint", () => {
		const openMobile: CommandVariantLatch = { mobile: true, open: true };
		// A phone rotated to landscape (e.g. 932px) reports desktop width.
		expect(resolveCommandVariant(openMobile, true, false)).toBe(true);
		expect(nextCommandVariantLatch(openMobile, true, false)).toBe(openMobile);
		const openDesktop: CommandVariantLatch = { mobile: false, open: true };
		expect(resolveCommandVariant(openDesktop, true, true)).toBe(false);
	});

	test("releases the latch once the palette closes", () => {
		const openMobile: CommandVariantLatch = { mobile: true, open: true };
		const closed = nextCommandVariantLatch(openMobile, false, false);
		expect(closed).toEqual({ mobile: false, open: false });
		expect(resolveCommandVariant(closed, true, false)).toBe(false);
	});
});
