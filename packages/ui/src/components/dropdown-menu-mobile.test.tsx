import { describe, expect, test } from "bun:test";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { CSSProperties } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	activateMobileSubmenuTrigger,
	mobileSubmenuItemProps,
	renderMobileSubmenuChildren,
} from "./dropdown-menu-mobile.ts";

describe("mobile submenu SDK prop adaptation", () => {
	test("child renderers receive the original empty payload and static children retain identity", () => {
		const child = <span>Submenu</span>;
		expect(renderMobileSubmenuChildren(child)).toBe(child);
		expect(renderMobileSubmenuChildren(null)).toBeNull();
		expect(renderMobileSubmenuChildren("Text")).toBe("Text");
		let calls = 0;
		const rendered = renderMobileSubmenuChildren((state) => {
			calls += 1;
			expect(state).toEqual({ payload: undefined });
			return child;
		});
		expect(rendered).toBe(child);
		expect(calls).toBe(1);
	});
	test("SDK element renderers and static CSS retain their original identities", () => {
		const render = <div />;
		const style: CSSProperties = { opacity: 0.5 };
		const adapted = mobileSubmenuItemProps({ render, style }, true);
		expect(adapted.render).toBe(render);
		expect(adapted.style).toBe(style);
		expect(mobileSubmenuItemProps({}, false)).toEqual({
			render: undefined,
			style: undefined,
		});
	});
	test("Base UI calls adapted render and style callbacks with the item state and current submenu open state", () => {
		for (const open of [false, true]) {
			const renderStates: MenuPrimitive.SubmenuTrigger.State[] = [];
			const styleStates: MenuPrimitive.SubmenuTrigger.State[] = [];
			const style: CSSProperties = { opacity: 0.5 };
			const adapted = mobileSubmenuItemProps(
				{
					render: (props, state) => {
						renderStates.push(state);
						return <div {...props} data-observed-open={state.open} />;
					},
					style: (state) => {
						styleStates.push(state);
						return style;
					},
				},
				open
			);
			expect(renderStates).toEqual([]);
			expect(styleStates).toEqual([]);
			const html = renderToStaticMarkup(
				<MenuPrimitive.Root>
					<MenuPrimitive.Item {...adapted}>Submenu</MenuPrimitive.Item>
				</MenuPrimitive.Root>
			);
			expect(renderStates).toEqual([
				{ disabled: false, highlighted: false, open },
			]);
			expect(styleStates).toEqual([
				{ disabled: false, highlighted: false, open },
			]);
			expect(html).toContain(`data-observed-open="${open}"`);
			expect(html).toContain('style="opacity:0.5"');
		}
	});
});

describe("mobile submenu trigger activation", () => {
	test("a pointer click opens the drawer page unless the caller prevents it", () => {
		expect(
			activateMobileSubmenuTrigger(
				new Event("click", { cancelable: true }),
				undefined
			)
		).toBe(true);
		expect(
			activateMobileSubmenuTrigger(
				new Event("click", { cancelable: true }),
				(event) => event.preventDefault()
			)
		).toBe(false);
	});

	test("a keyboard activation opens the drawer page although Base UI already prevented the keydown", () => {
		// Base UI's useButton prevents a non-native item's Enter keydown and then
		// passes that same event to onClick; the drawer must still navigate.
		const keydown = new Event("keydown", { cancelable: true });
		keydown.preventDefault();
		const seenByCaller: boolean[] = [];
		expect(
			activateMobileSubmenuTrigger(keydown, (event) => {
				seenByCaller.push(event.defaultPrevented);
			})
		).toBe(true);
		expect(seenByCaller).toEqual([true]);
	});
});
