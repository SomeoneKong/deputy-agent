/**
 * Atomic file write: tmp + fsync + atomic rename.
 *
 * Failure semantics: on any step error, remove the tmp file, leave the original
 * untouched, and rethrow for the caller to handle.
 * Single-writer assumption: only one writer per path at a time (the `<path>.tmp`
 * suffix is shared); concurrent writes to the same path overwrite each other.
 * The parent directory must already exist (this tool does not create it).
 */
import { open, rename, rm } from "node:fs/promises";

export interface AtomicWriter {
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  writeText(path: string, content: string, encoding?: BufferEncoding): Promise<void>;
}

async function writeBytesAtomic(path: string, data: Uint8Array): Promise<void> {
  const tmp = `${path}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, "w");
    await handle.write(data);
    await handle.sync();
  } catch (err) {
    await handle?.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  // Close before rename (on Windows an open handle makes rename throw EBUSY/EPERM).
  await handle.close();
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export const atomicWriter: AtomicWriter = {
  writeBytes: writeBytesAtomic,
  async writeText(path, content, encoding = "utf8") {
    await writeBytesAtomic(path, Buffer.from(content, encoding));
  },
};
