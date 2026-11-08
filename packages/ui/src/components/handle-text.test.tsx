import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HandleText, handleLabel } from "./handle-text.tsx";
import { WaitlistPass } from "./waitlist-pass.tsx";

const LRI = String.fromCodePoint(0x20_66);
const PDI = String.fromCodePoint(0x20_69);

test("renders a handle as a left-to-right bdi inside an rtl root", () => {
	const html = renderToStaticMarkup(
		<div dir="rtl">
			<HandleText className="truncate" name="alice" />
		</div>
	);
	expect(html).toBe(
		'<div dir="rtl"><bdi class="truncate" dir="ltr">@alice</bdi></div>'
	);
	const text = html.replace(/<[^>]*>/gu, "");
	expect(text).toBe("@alice");
});

test("isolates a string handle left to right for string-only props", () => {
	expect(handleLabel("alice")).toBe(`${LRI}@alice${PDI}`);
	expect(handleLabel("alice").length).toBe("@alice".length + 2);
});

test("the waitlist pass keeps a handle-only name and handle line as @name", () => {
	const handleOnly = renderToStaticMarkup(
		<WaitlistPass position={12} username="alice" />
	);
	expect(handleOnly).toContain(`${LRI}@alice${PDI}`);

	const named = renderToStaticMarkup(
		<WaitlistPass name="Alice" position={12} username="alice" />
	);
	expect(named).toContain(">Alice<");
	expect(named).toContain(`${LRI}@alice${PDI}`);
});
