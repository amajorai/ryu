import { afterEach, expect, test } from "bun:test";
import { authBackendUrl, frontendUrl } from "./controlPlane.ts";

const saved = {
	RYU_AUTH_URL: process.env.RYU_AUTH_URL,
	RYU_FRONTEND_URL: process.env.RYU_FRONTEND_URL,
	RYU_PROFILE: process.env.RYU_PROFILE,
};

afterEach(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
});

test("an installed CLI reaches the hosted control plane without configuration", () => {
	delete process.env.RYU_AUTH_URL;
	delete process.env.RYU_FRONTEND_URL;
	delete process.env.RYU_PROFILE;
	expect(authBackendUrl()).toBe("https://api.ryuhq.com");
	expect(frontendUrl()).toBe("https://ryuhq.com");
	process.env.RYU_PROFILE = "nightly";
	expect(authBackendUrl()).toBe("https://api.ryuhq.com");
});

test("a dev checkout defaults to the local server and web app", () => {
	delete process.env.RYU_AUTH_URL;
	delete process.env.RYU_FRONTEND_URL;
	process.env.RYU_PROFILE = " Dev ";
	expect(authBackendUrl()).toBe("http://localhost:3000");
	expect(frontendUrl()).toBe("http://localhost:3001");
});

test("explicit URLs win over the profile default", () => {
	process.env.RYU_PROFILE = "dev";
	process.env.RYU_AUTH_URL = " https://auth.example.test ";
	process.env.RYU_FRONTEND_URL = "https://web.example.test";
	expect(authBackendUrl()).toBe("https://auth.example.test");
	expect(frontendUrl()).toBe("https://web.example.test");
});
