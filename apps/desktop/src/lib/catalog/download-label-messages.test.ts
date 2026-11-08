import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LiteralMessage } from "@ryu/i18n";
import { formatMessage } from "@ryu/i18n/lite";
import {
	DOWNLOAD_LABEL_MESSAGES,
	localizedDownloadLabel,
} from "./download-label-messages.ts";
import { DOWNLOAD_LABEL_MIRRORS } from "./download-label-mirrors.fixture.ts";
import { friendlyDownloadLabel } from "./friendly.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../../..");

/** Japanese stand-ins for the explicit `tl` keys, as a catalog would hold them. */
const JA: Record<string, string> = {
	"Ryu update ({name})": "Ryu アップデート ({name})",
	"{label} tool and skill router weights":
		"{label} のツールとスキルのルーター重み",
	"{label} tool and skill router": "{label} のツールとスキルのルーター",
	"App sidecar bundle: {url}": "アプリのサイドカーバンドル: {url}",
	"App sidecar: {command}": "アプリのサイドカー: {command}",
	"Plugin runtime source: {url}": "プラグインのランタイムソース: {url}",
	"Plugin asset: {source}": "プラグインのアセット: {source}",
	"Plugin sidecar binary: {url}": "プラグインのサイドカーバイナリ: {url}",
	"Plugin sidecar archive: {url}": "プラグインのサイドカーアーカイブ: {url}",
	"{name} runtime": "{name} ランタイム",
	"{name} model": "{name} モデル",
	"{name} sidecar": "{name} サイドカー",
	"{name} voice": "{name} 音声",
	"{name} (weights)": "{name} (重み)",
	"{name} (vocoder)": "{name} (ボコーダー)",
	"{name} (voice pack)": "{name} (音声パック)",
	"llama.cpp ({variant})": "llama.cpp ({variant})",
	"CPU only": "CPU のみ",
	"Apple GPU (Metal)": "Apple GPU (Metal)",
	"NVIDIA GPU (CUDA)": "NVIDIA GPU (CUDA)",
	"GPU (Vulkan)": "GPU (Vulkan)",
	"{name} (archive)": "{name} (アーカイブ)",
	"{name} text encoder ({detail})": "{name} テキストエンコーダー ({detail})",
	"{name} image encoder": "{name} 画像エンコーダー",
	"{name} vision projector ({detail})":
		"{name} ビジョンプロジェクター ({detail})",
	"{name} video model ({detail})": "{name} 動画モデル ({detail})",
};

const ja: LiteralMessage = (source, values = {}) =>
	formatMessage(JA[source] ?? source, values, "ja");
const en: LiteralMessage = (source, values = {}) =>
	formatMessage(source, values, "en");

/** One real Core label per table entry, in table order, and its ja rendering. */
const SAMPLES: readonly [string, string][] = [
	[
		"Ryu update (ryu-core-x86_64.tar.gz)",
		"Ryu アップデート (ryu-core-x86_64.tar.gz)",
	],
	[
		"Needle tool and skill router weights",
		"Needle のツールとスキルのルーター重み",
	],
	["Needle tool and skill router", "Needle のツールとスキルのルーター"],
	[
		"app sidecar bundle: https://example.com/a/bundle.tar.gz",
		"アプリのサイドカーバンドル: https://example.com/a/bundle.tar.gz",
	],
	["app sidecar: uvx", "アプリのサイドカー: uvx"],
	[
		"plugin runtime source: https://example.com/rt.zip",
		"プラグインのランタイムソース: https://example.com/rt.zip",
	],
	["plugin asset: weights.bin", "プラグインのアセット: weights.bin"],
	[
		"plugin sidecar binary: https://example.com/bin",
		"プラグインのサイドカーバイナリ: https://example.com/bin",
	],
	[
		"plugin sidecar archive: https://example.com/a.tgz",
		"プラグインのサイドカーアーカイブ: https://example.com/a.tgz",
	],
	["CUDA runtime", "CUDA ランタイム"],
	["Silero VAD model", "Silero VAD モデル"],
	["audio.cpp Alba voice", "audio.cpp Alba 音声"],
	["OuteTTS (weights)", "OuteTTS (重み)"],
	["OuteTTS (vocoder)", "OuteTTS (ボコーダー)"],
	["Kokoro 82M (voice pack)", "Kokoro 82M (音声パック)"],
	["llama.cpp (CPU only)", "llama.cpp (CPU のみ)"],
	["Ryu Audio sidecar", "Ryu Audio サイドカー"],
	["Parakeet v3 (archive)", "Parakeet v3 (アーカイブ)"],
	["umt5-xxl text encoder (Q5_K_M)", "umt5-xxl テキストエンコーダー (Q5_K_M)"],
	["CLIP-vision H image encoder", "CLIP-vision H 画像エンコーダー"],
	[
		"Qwen3-VL-8B vision projector (F16)",
		"Qwen3-VL-8B ビジョンプロジェクター (F16)",
	],
	["Wan2.1 T2V 1.3B video model (Q8_0)", "Wan2.1 T2V 1.3B 動画モデル (Q8_0)"],
];

describe("localizedDownloadLabel", () => {
	it("has one sample per table entry, matched by that entry first", () => {
		expect(SAMPLES.length).toBe(DOWNLOAD_LABEL_MESSAGES.length);
		for (const [index, [label]] of SAMPLES.entries()) {
			const first = DOWNLOAD_LABEL_MESSAGES.findIndex((entry) =>
				entry.pattern.test(label)
			);
			expect(first).toBe(index);
		}
	});

	it("renders every recognized label in Japanese", () => {
		for (const [label, expected] of SAMPLES) {
			expect(localizedDownloadLabel(label, ja)).toBe(expected);
		}
	});

	it("keeps the English wording apart from the leading capital", () => {
		expect(localizedDownloadLabel("CUDA runtime", en)).toBe("CUDA runtime");
		expect(localizedDownloadLabel("app sidecar: uvx", en)).toBe(
			"App sidecar: uvx"
		);
	});

	it("shortens URL placeholders in compact mode only", () => {
		const label = "app sidecar bundle: https://example.com/a/bundle.tar.gz";
		expect(localizedDownloadLabel(label, ja, { compact: true })).toBe(
			"アプリのサイドカーバンドル: bundle.tar.gz"
		);
		expect(
			localizedDownloadLabel("Ryu update (dir/x.tar.gz)", ja, {
				compact: true,
			})
		).toBe("Ryu アップデート (dir/x.tar.gz)");
	});

	it("covers every mirrored label of a multi-label entry", () => {
		expect(localizedDownloadLabel("audio.cpp PocketTTS model", ja)).toBe(
			"audio.cpp PocketTTS モデル"
		);
		expect(localizedDownloadLabel("Kokoro 82M (weights)", ja)).toBe(
			"Kokoro 82M (重み)"
		);
		expect(localizedDownloadLabel("llama.cpp (NVIDIA GPU (CUDA))", en)).toBe(
			"llama.cpp (NVIDIA GPU (CUDA))"
		);
		expect(
			localizedDownloadLabel("llama.cpp (Some future GPU)", ja)
		).toBeNull();
	});

	it("returns null for labels of no known shape", () => {
		expect(localizedDownloadLabel("llama.cpp", ja)).toBeNull();
		expect(localizedDownloadLabel("Ollama", ja)).toBeNull();
		expect(
			localizedDownloadLabel("unsloth/gemma-4-12B-it-GGUF (x.gguf)", ja)
		).toBeNull();
	});
});

describe("friendlyDownloadLabel with tl", () => {
	it("localizes a recognized Core label of any kind", () => {
		expect(friendlyDownloadLabel("Ryu update (ryu.tar.gz)", "update", ja)).toBe(
			"Ryu アップデート (ryu.tar.gz)"
		);
		expect(friendlyDownloadLabel("whisper.cpp model", "model", ja)).toBe(
			"whisper.cpp モデル"
		);
	});

	it("keeps the existing friendly path for other labels", () => {
		expect(
			friendlyDownloadLabel(
				"unsloth/gemma-4-12B-it-GGUF (gemma-4-12B-it-Q4_K_M.gguf)",
				"model",
				ja
			)
		).toBe("Gemma 4 · Balanced (recommended)");
		expect(friendlyDownloadLabel("llama.cpp", "engine", ja)).toBe("llama.cpp");
	});
});

describe("Rust template drift guard", () => {
	it("every mirrored English template still appears in its Rust source", () => {
		expect(DOWNLOAD_LABEL_MIRRORS.length).toBeGreaterThan(0);
		for (const { file, template } of DOWNLOAD_LABEL_MIRRORS) {
			const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
			expect({ file, found: source.includes(template) }).toEqual({
				file,
				found: true,
			});
		}
	});
});
