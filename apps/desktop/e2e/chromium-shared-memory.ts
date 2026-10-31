// Chooses where Chromium keeps its renderer shared memory for the native HTTP
// chat-page harness.
//
// Playwright always launches Chromium with `--disable-dev-shm-usage`, which
// moves shared memory from /dev/shm to the temp directory, because container
// /dev/shm is often only 64 MB. The harness serves about 2,300 unbundled
// modules, and on a page load or reload each response holds a shared-memory
// data pipe until the module is parsed. When the temp directory sits on a
// nearly full disk, that burst cannot be backed: module fetches fail with
// net::ERR_INSUFFICIENT_RESOURCES, the app never boots after `page.reload()`,
// and a renderer that loses its backing store can crash outright. When
// /dev/shm has room for the burst, keep Chromium's default and use it.
import { statfsSync } from "node:fs";

const MIN_DEV_SHM_BYTES = 2 * 1024 ** 3;

function devShmAvailableBytes(): number {
	try {
		const stats = statfsSync("/dev/shm");
		return stats.bavail * stats.bsize;
	} catch {
		return 0;
	}
}

// Default Playwright arguments to drop so Chromium keeps shared memory in /dev/shm.
export function ignoredSharedMemoryArgs(): string[] {
	return devShmAvailableBytes() >= MIN_DEV_SHM_BYTES
		? ["--disable-dev-shm-usage"]
		: [];
}
