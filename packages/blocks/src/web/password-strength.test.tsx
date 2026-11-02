import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { PasswordStrengthMeter } = await import("./password-strength.tsx");
const { passwordIssueText } = await import("./password-policy-copy.ts");

const roots: Root[] = [];

async function render(node: ReactNode): Promise<HTMLElement> {
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	roots.push(root);
	await act(async () => {
		root.render(node);
	});
	return mount;
}

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await act(async () => {
			root.unmount();
		});
	}
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

describe("PasswordStrengthMeter", () => {
	test("renders four bars and marks every strong requirement", () => {
		const html = renderToStaticMarkup(
			<PasswordStrengthMeter value="RyuLaunch!9" />
		);
		expect(html).toContain('data-strength-score="4"');
		expect(html).toContain('data-strength="strong"');
		expect(html).toContain(">Strong<");
		expect(html.match(/data-testid="password-strength-meter"/g)).toHaveLength(
			1
		);
		expect(html).toContain("At least 8 characters");
		expect(html).toContain("One symbol");
	});

	test("starts empty without hiding the requirements", () => {
		const html = renderToStaticMarkup(<PasswordStrengthMeter value="" />);
		expect(html).toContain('data-strength-score="0"');
		expect(html).toContain('data-strength="too_weak"');
		expect(html).toContain(">Too weak<");
		expect(html).toContain('role="progressbar"');
	});

	test("reads the label, its accessible name and the rules in the reader's language", async () => {
		registerLiteralCatalogLoader(() => ({
			"One number": "数字を1つ",
			"One symbol": "記号を1つ",
			"One uppercase letter": "大文字を1つ",
			"Password strength": "パスワードの強度",
			"Password strength: {label}": "パスワードの強度: {label}",
			Strong: "強い",
		}));
		const mount = await render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<PasswordStrengthMeter value="RyuLaunch!9" />
			</I18nProvider>
		);
		const bars = mount.querySelector("[role='progressbar']");
		expect(bars?.getAttribute("aria-label")).toBe("パスワードの強度: 強い");
		const text = mount.textContent ?? "";
		expect(text).toContain("大文字を1つ");
		expect(text).toContain("数字を1つ");
		expect(text).toContain("記号を1つ");
		expect(text).not.toContain("Strong");
		expect(text).not.toContain("One symbol");
	});
});

describe("passwordIssueText", () => {
	test("gives English for every issue code by default", () => {
		expect(passwordIssueText("length")).toBe(
			"Password needs at least 8 characters"
		);
		expect(passwordIssueText("max_length")).toBe(
			"Password must be 128 characters or fewer"
		);
		expect(passwordIssueText("symbol")).toBe("Password needs one symbol");
	});
});
