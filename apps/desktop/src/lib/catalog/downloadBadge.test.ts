// Tests for the download-row type badge. Pure functions, no React.
import { describe, expect, it } from "bun:test";
import { downloadBadge, stripRoleSuffix } from "./downloadBadge.ts";

describe("downloadBadge", () => {
	it("badges by role, not by the coarse kind", () => {
		// Both are kind "model" — only the role tells them apart, which is the whole
		// reason the role exists.
		expect(downloadBadge("chat_model", "model", "gemma")?.label).toBe(
			"Chat model"
		);
		expect(downloadBadge("embedding_model", "model", "nomic")?.label).toBe(
			"Embedding"
		);
		expect(downloadBadge("reranker_model", "model", "bge")?.label).toBe(
			"Reranker"
		);
		expect(
			downloadBadge("classifier_model", "model", "gemma-270m")?.label
		).toBe("Classifier");
		expect(
			downloadBadge("plugin_model", "model", "Cactus-Compute/needle3")?.label
		).toBe("Local model");
	});

	it("distinguishes speech, voice and image weights from their engines", () => {
		expect(downloadBadge("engine", "voice", "whisper.cpp")?.label).toBe(
			"Engine"
		);
		expect(downloadBadge("speech_model", "voice", "whisper model")?.label).toBe(
			"Speech model"
		);
		expect(downloadBadge("voice_model", "voice", "Kokoro 82M")?.label).toBe(
			"Voice model"
		);
		expect(downloadBadge("image_model", "media", "sd model")?.label).toBe(
			"Image model"
		);
	});

	it("marks an unpack step as unpacking, not a download", () => {
		expect(
			downloadBadge("extract", "voice", "Parakeet v3 (unpack)")?.label
		).toBe("Unpacking");
	});

	/// A catalog install fetches the vision adapter through the same chat-model
	/// spec, so the filename is the only place that distinction exists.
	it("refines a companion artifact out of the filename", () => {
		expect(
			downloadBadge("chat_model", "model", "org/repo (model-mmproj-f16.gguf)")
				?.label
		).toBe("Vision add-on");
		expect(
			downloadBadge("chat_model", "model", "org/repo (model-Q8_0-MTP.gguf)")
				?.label
		).toBe("Speed add-on");
		// An ordinary quant is untouched.
		expect(
			downloadBadge("chat_model", "model", "org/repo (model-Q4_K_M.gguf)")
				?.label
		).toBe("Chat model");
	});

	/// A task persisted by an older Core deserializes with no role at all; it must
	/// still badge rather than render blank.
	it("falls back to kind when the task carries no role", () => {
		expect(downloadBadge(undefined, "engine", "llama.cpp")?.label).toBe(
			"Engine"
		);
		expect(downloadBadge(undefined, "agent", "ZeroClaw")?.label).toBe("Agent");
		expect(downloadBadge(undefined, "skill", "some-skill")?.label).toBe(
			"Skill"
		);
	});

	it("says nothing when nothing useful can be said", () => {
		expect(downloadBadge("other", "other", "a blob")).toBeNull();
	});
});

describe("stripRoleSuffix", () => {
	it("drops the parenthetical the badge now carries", () => {
		expect(stripRoleSuffix("nomic-embed-v1.5 (embedding model)")).toBe(
			"nomic-embed-v1.5"
		);
		expect(stripRoleSuffix("gemma-4 (chat model)")).toBe("gemma-4");
		expect(stripRoleSuffix("bge-v2 (reranker model)")).toBe("bge-v2");
		expect(stripRoleSuffix("repo (vision adapter)")).toBe("repo");
	});

	it("keeps a parenthetical that is real information", () => {
		// The filename half of a catalog download is what tells the user WHICH file
		// is coming — never strip it.
		expect(stripRoleSuffix("org/repo (model-Q4_K_M.gguf)")).toBe(
			"org/repo (model-Q4_K_M.gguf)"
		);
		expect(stripRoleSuffix("Kokoro 82M (voice pack)")).toBe(
			"Kokoro 82M (voice pack)"
		);
	});

	it("never returns an empty label", () => {
		expect(stripRoleSuffix("(chat model)")).toBe("(chat model)");
	});
});
