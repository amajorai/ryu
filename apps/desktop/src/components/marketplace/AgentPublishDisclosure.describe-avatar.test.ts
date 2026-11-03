import { expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { AgentDescriptor } from "@/src/lib/publish/packaging.ts";
import { describeAvatar } from "./AgentPublishDisclosure.tsx";

// Every part of the appearance summary is a whole catalog phrase. This
// translator knows only those phrases and fails on anything else, so an English
// fragment glued around a phrase cannot reach the joined list.
const JA: Record<string, string> = {
	"a Marketplace avatar style ({style})":
		"マーケットプレイスのアバタースタイル（{style}）",
	"a custom icon": "カスタムアイコン",
	"a dither gradient": "ディザーグラデーション",
	"a generated avatar": "生成されたアバター",
	"a linked image": "リンクされた画像",
	"an expressive {expression} ghost avatar with {animation} animation":
		"{animation}アニメーション付きの{expression}な表情のゴーストアバター",
	"an expressive random ghost avatar": "ランダムな表情のゴーストアバター",
	"emoji {emoji}": "絵文字 {emoji}",
	'tone "{tone}"': "トーン「{tone}」",
};

const jaMessage: LiteralMessage = (message, values) => {
	const template = JA[message];
	if (template === undefined) {
		throw new Error(`untranslated phrase: ${message}`);
	}
	return template.replace(/\{(\w+)\}/g, (_, name: string) =>
		String((values as Record<string, unknown> | undefined)?.[name] ?? "")
	);
};

function descriptorWith(avatar: AgentDescriptor["avatar"]): AgentDescriptor {
	return { avatar } as AgentDescriptor;
}

test("describes every glyph source in Japanese with no English fragment", () => {
	const label = describeAvatar(
		descriptorWith({
			avatar_style: { seed: "s", style: "ピクセル" },
			avatar_url: "https://example.test/a.png",
			dicebear: { seed: null, style: null },
			dither: { direction: null, from: null, to: null },
			emoji: "🙂",
			expressive: {
				animation: "まばたき",
				expression: "笑顔",
			} as NonNullable<AgentDescriptor["avatar"]>["expressive"],
			icon: "star",
			icon_color: null,
			tone: "穏やか",
		}),
		jaMessage,
		"ja"
	);
	expect(label).not.toBeNull();
	expect(label).not.toMatch(/[A-Za-z]/);
	expect(label).not.toContain(", ");
	expect(label).toContain("絵文字 🙂");
	expect(label).toContain("トーン「穏やか」");
});

test("names a ghost avatar with no chosen expression as random", () => {
	const label = describeAvatar(
		descriptorWith({
			avatar_url: null,
			dicebear: null,
			dither: null,
			emoji: null,
			expressive: { animation: null, expression: null } as NonNullable<
				AgentDescriptor["avatar"]
			>["expressive"],
			icon: null,
			icon_color: null,
			tone: null,
		}),
		jaMessage,
		"ja"
	);
	expect(label).toBe("ランダムな表情のゴーストアバター");
});

test("returns null when the agent carries no avatar", () => {
	expect(describeAvatar(descriptorWith(null), jaMessage, "ja")).toBeNull();
});
