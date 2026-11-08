import { isolateLtr } from "@ryu/i18n/format-bidi";

/**
 * A standalone `@handle` shown in the page's own direction.
 *
 * Under `dir="rtl"` a bare `@alice` lets its leading `@` take the paragraph
 * direction and draws as `alice@`. Handles are left-to-right identifiers, so
 * `<HandleText>` lays the sigil and the name out together in a left-to-right
 * `<bdi>`, which the surrounding right-to-left text treats as one unit. Use it
 * for handles placed directly in JSX; a handle inside a translated sentence is
 * isolated by `tl()` itself.
 */
export function HandleText({
	className,
	name,
}: {
	className?: string;
	name: string;
}) {
	return (
		<bdi className={className} dir="ltr">
			{`@${name}`}
		</bdi>
	);
}

/**
 * `@name` as a plain string, wrapped in LRI ... PDI so it stays `@name` in a
 * right-to-left layout. For props that only take a string (`AutoFitText`,
 * `title`); the marks are zero width and do not change the measured fit.
 */
export function handleLabel(name: string): string {
	return isolateLtr(`@${name}`);
}
