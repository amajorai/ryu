import { describe, expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { useFileUpload } from "./useFileUpload.ts";

// The avatar validation messages show in the upload error and the toast, so
// they must follow the UI language like the rest of the profile settings.

const INVALID_TYPE =
	"Invalid file type. Please upload a JPEG, PNG, or WebP image.";
const TOO_LARGE = "File is too large. Maximum size is 10MB.";
const JA: Record<string, string> = {
	[INVALID_TYPE]:
		"無効なファイル形式です。JPEG、PNG、WebP の画像をアップロードしてください。",
	[TOO_LARGE]: "ファイルが大きすぎます。最大サイズは 10MB です。",
};

function Probe({ file }: { file: File }) {
	const { validateFile } = useFileUpload();
	return <output>{validateFile(file) ?? "valid"}</output>;
}

function validationText(locale: string, file: File): string {
	const html = renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			initialPackId={null}
			manageDocument={false}
			overlays={{ ja: JA }}
		>
			<Probe file={file} />
		</I18nProvider>
	);
	return html.replaceAll(/<[^>]*>/g, "");
}

const textFile = new File(["hello"], "notes.txt", { type: "text/plain" });
const hugeImage = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.png", {
	type: "image/png",
});
const smallImage = new File([new Uint8Array(8)], "me.webp", {
	type: "image/webp",
});

describe("useFileUpload validation", () => {
	test("an invalid file type is refused in Japanese", () => {
		expect(validationText("ja", textFile)).toBe(JA[INVALID_TYPE] ?? "");
	});

	test("an oversized image is refused in Japanese", () => {
		expect(validationText("ja", hugeImage)).toBe(JA[TOO_LARGE] ?? "");
	});

	test("English keeps the source sentences and accepts a small image", () => {
		expect(validationText("en", textFile)).toBe(INVALID_TYPE);
		expect(validationText("en", smallImage)).toBe("valid");
	});
});
