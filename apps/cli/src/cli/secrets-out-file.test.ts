import { afterEach, expect, test } from "bun:test";
import { constants } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AccessCheck,
	checkOutParent,
	createExclusive,
	type OpenFile,
	replaceExclusive,
	writeFailure,
} from "./secrets-out-file.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		await chmod(dir, 0o700).catch(() => undefined);
		await rm(dir, { force: true, recursive: true });
	}
});
async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ryu-out-file-"));
	dirs.push(dir);
	return dir;
}

test("a missing parent folder, or a file posing as one, is refused up front", async () => {
	const dir = await scratch();
	await expect(
		checkOutParent(join(dir, "nope", "k"), "nope/k")
	).rejects.toThrow("does not exist");
	await writeFile(join(dir, "plain"), "x");
	await expect(
		checkOutParent(join(dir, "plain", "k"), "plain/k")
	).rejects.toThrow("does not exist");
	await checkOutParent(join(dir, "k"), "k");
});

test("createExclusive sets the mode on the new file and never follows a symlink", async () => {
	const dir = await scratch();
	const key = join(dir, "a.key");
	await createExclusive(key, "secret\n", 0o600);
	expect(await readFile(key, "utf8")).toBe("secret\n");
	expect((await stat(key)).mode & 0o777).toBe(0o600);
	const link = join(dir, "link.key");
	await symlink(join(dir, "elsewhere"), link);
	await expect(createExclusive(link, "secret", 0o600)).rejects.toThrow();
	await expect(stat(join(dir, "elsewhere"))).rejects.toThrow();
	await expect(createExclusive(key, "again")).rejects.toThrow();
	expect(await readFile(key, "utf8")).toBe("secret\n");
});

test("a write that fails part-way leaves no partial file", async () => {
	const dir = await scratch();
	const path = join(dir, "partial.key");
	// A data value the handle cannot write fails after the file was created.
	await expect(
		createExclusive(path, Symbol("not data") as never, 0o600)
	).rejects.toThrow();
	expect(await readdir(dir)).toEqual([]);
});

test("replaceExclusive replaces a symlink itself and leaves no staging file", async () => {
	const dir = await scratch();
	const link = join(dir, "out");
	await symlink(join(dir, "target"), link);
	await replaceExclusive(link, "new", 0o600);
	expect(await readFile(link, "utf8")).toBe("new");
	await expect(stat(join(dir, "target"))).rejects.toThrow();
	expect((await readdir(dir)).sort()).toEqual(["out"]);
	expect(writeFailure(Object.assign(new Error("x"), { code: "ENOSPC" }))).toBe(
		"ENOSPC"
	);
});

test("the mode is set on the handle, so a umask cannot change it", async () => {
	const dir = await scratch();
	const key = join(dir, "umask.key");
	// This umask strips the owner's write bit from any mode open() is given.
	const previous = process.umask(0o277);
	try {
		await createExclusive(key, "secret\n", 0o600);
	} finally {
		process.umask(previous);
	}
	expect((await stat(key)).mode & 0o777).toBe(0o600);
});

test("a close that fails removes the file, since the data may not be on disk", async () => {
	const dir = await scratch();
	const path = join(dir, "close.key");
	const failingClose: OpenFile = async (file, flags, mode) => {
		const handle = await open(file, flags, mode);
		return new Proxy(handle, {
			get(target, name, receiver) {
				if (name === "close") {
					return async () => {
						await target.close();
						throw Object.assign(new Error("close failed"), { code: "EIO" });
					};
				}
				const value = Reflect.get(target, name, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	};
	await expect(
		createExclusive(path, "secret", 0o600, failingClose)
	).rejects.toThrow("close failed");
	expect(await readdir(dir)).toEqual([]);
});

test("a folder that is writable but not searchable is refused up front", async () => {
	const dir = await scratch();
	const asked: number[] = [];
	// A 0o200 folder: writing is allowed, searching (X_OK) is not.
	const writeOnlyFolder: AccessCheck = async (_path, mode) => {
		asked.push(mode);
		if (mode & constants.X_OK) {
			throw Object.assign(new Error("denied"), { code: "EACCES" });
		}
	};
	await expect(
		checkOutParent(join(dir, "k"), "k", writeOnlyFolder)
	).rejects.toThrow("is not writable");
	expect(asked).toEqual([constants.W_OK | constants.X_OK]);
});

// Root passes access() whatever the permission bits, and Windows has no
// search bit, so this real-folder check runs only as an ordinary POSIX user;
// the test above covers both.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
	"a real 0o200 folder is refused up front",
	async () => {
		const dir = await scratch();
		const folder = join(dir, "write-only");
		await mkdir(folder);
		await chmod(folder, 0o200);
		// Restored and removed before its parent (see afterEach).
		dirs.unshift(folder);
		await expect(checkOutParent(join(folder, "k"), "k")).rejects.toThrow(
			"is not writable"
		);
	}
);

test("a failed write never removes a file another writer swapped in", async () => {
	const dir = await scratch();
	const path = join(dir, "swap.key");
	const swapThenFail: OpenFile = async (file, flags, mode) => {
		const handle = await open(file, flags, mode);
		return new Proxy(handle, {
			get(target, name, receiver) {
				if (name === "writeFile") {
					return async () => {
						// Another writer moves ours aside and puts its own file there.
						await rename(file, join(dir, "moved-aside"));
						await writeFile(file, "theirs");
						throw Object.assign(new Error("write failed"), { code: "EIO" });
					};
				}
				const value = Reflect.get(target, name, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	};
	await expect(
		createExclusive(path, "secret", 0o600, swapThenFail)
	).rejects.toThrow("write failed");
	expect(await readFile(path, "utf8")).toBe("theirs");
});
