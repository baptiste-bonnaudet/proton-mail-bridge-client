import { chmod, mkdir } from "node:fs/promises";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Create the directory if needed and ensure it is only accessible by the current user. */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  // mkdir's mode only applies to directories it creates; tighten pre-existing ones too.
  await chmod(path, PRIVATE_DIR_MODE);
}

/** Restrict an existing file to the current user. Missing files are ignored. */
export async function ensurePrivateFile(path: string): Promise<void> {
  try {
    await chmod(path, PRIVATE_FILE_MODE);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return;
    }
    throw error;
  }
}
