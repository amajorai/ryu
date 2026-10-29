import { describe, expect, test } from "bun:test";
import { ApiError } from "./client.ts";
import { ModelInstallBlockedError, toModelInstallError } from "./models.ts";

const PATH = "/api/models/catalog/install";

describe("toModelInstallError", () => {
	test("maps a 422 refusal to Core's message and code", () => {
		const body = {
			code: "insufficient_disk",
			message: "Not enough free disk space: needs 6 GB, 3 GB free.",
			verdict: "no_space",
		};
		const mapped = toModelInstallError(
			new ApiError(PATH, 422, undefined, undefined, body)
		);
		expect(mapped).toBeInstanceOf(ModelInstallBlockedError);
		const blocked = mapped as ModelInstallBlockedError;
		expect(blocked.message).toBe(body.message);
		expect(blocked.code).toBe("insufficient_disk");
	});

	test("prefers the error-envelope message when Core sends one", () => {
		const mapped = toModelInstallError(
			new ApiError(PATH, 422, "Too large for this device", "model_too_large", {
				error: {
					code: "model_too_large",
					message: "Too large for this device",
				},
			})
		) as ModelInstallBlockedError;
		expect(mapped.message).toBe("Too large for this device");
		expect(mapped.code).toBe("model_too_large");
	});

	test("passes every other failure through unchanged", () => {
		const other = new ApiError(PATH, 500);
		expect(toModelInstallError(other)).toBe(other);
		const plain = new Error("offline");
		expect(toModelInstallError(plain)).toBe(plain);
	});
});
