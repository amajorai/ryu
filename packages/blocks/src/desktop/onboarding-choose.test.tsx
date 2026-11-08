import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChooseStep } from "./onboarding-choose.tsx";
import type { OnboardingViewProps } from "./onboarding-types.ts";

const noop = () => undefined;

function failedLocalCard(localError: OnboardingViewProps["localError"]) {
	return renderToStaticMarkup(
		<div dir="rtl" lang="ar">
			<ChooseStep
				isDesktop
				localChecking={false}
				localError={localError}
				localUnreachable
				managedBusy={false}
				managedEntitled={false}
				managedLoading={false}
				onChooseLocal={noop}
				onChooseManaged={noop}
				onChooseRemote={noop}
				onDownloadDesktop={noop}
			/>
		</div>
	);
}

test("a coded failure shows the translated sentence, with the raw cause isolated left to right", () => {
	const html = failedLocalCard({
		message: "تعذّر على Ryu تثبيت وقت التشغيل المحلي.",
		detail: "No space left on device (os error 28)",
	});
	expect(html).toContain(
		'<p class="mt-2 text-muted-foreground text-sm">تعذّر على Ryu تثبيت وقت التشغيل المحلي.</p>'
	);
	expect(html).toMatch(
		/<details[^>]*><summary[^>]*>Details<\/summary><p[^>]*dir="ltr"[^>]*><bdi>No space left on device \(os error 28\)<\/bdi><\/p><\/details>/
	);
});

test("a sentence without a technical cause renders no Details disclosure", () => {
	const html = failedLocalCard({
		message: "يقوم Ryu بتثبيت تحديث للتطبيق.",
		detail: null,
	});
	expect(html).toContain("يقوم Ryu بتثبيت تحديث للتطبيق.");
	expect(html).not.toContain("<details");
});

test("a legacy plain-string error stays only under Details", () => {
	const html = failedLocalCard("HTTP 404");
	expect(html).not.toContain('text-sm">HTTP 404');
	expect(html).toContain("<bdi>HTTP 404</bdi>");
});
