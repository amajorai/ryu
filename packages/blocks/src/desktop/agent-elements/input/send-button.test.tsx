import { expect, test } from "bun:test";
import { ArrowUp02Icon, CallIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { renderToStaticMarkup } from "react-dom/server";
import { SendButton, VoiceCallButton } from "./send-button.tsx";

test("uses the same upward-arrow affordance when idle and typing", () => {
	const idleMarkup = renderToStaticMarkup(<SendButton state="idle" />);
	const typingMarkup = renderToStaticMarkup(<SendButton state="typing" />);
	const arrow = renderToStaticMarkup(
		<HugeiconsIcon className="size-4" icon={ArrowUp02Icon} />
	);

	expect(idleMarkup).toContain(arrow);
	expect(typingMarkup).toContain(arrow);
	// Empty: the send slot stays, disabled and dimmed rather than swapped out.
	expect(idleMarkup).toContain("disabled");
	expect(idleMarkup).toContain("disabled:opacity-30");
	expect(typingMarkup).not.toContain("disabled:opacity-30");
});

test("voice call is its own quiet button, never the send slot", () => {
	const markup = renderToStaticMarkup(
		<VoiceCallButton onStart={() => undefined} />
	);

	expect(markup).toContain('aria-label="Start voice call"');
	expect(markup).toContain('title="Start voice call"');
	expect(markup).toContain(
		renderToStaticMarkup(<HugeiconsIcon className="size-4" icon={CallIcon} />)
	);
	expect(renderToStaticMarkup(<SendButton state="idle" />)).not.toContain(
		"Start voice call"
	);
});
