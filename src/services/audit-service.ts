import { appendFile, readFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuditEntry, ProtonMailConfig } from "../types/index.js";
import { PRIVATE_FILE_MODE, ensurePrivateDir } from "../utils/secure-fs.js";

const MAX_AUDIT_BYTES = 5 * 1024 * 1024;
const MAX_AUDIT_LINES = 10000;

export class AuditService {
  private readonly auditPath: string;
  private readonly archivePath: string;
  private _rotateLock: Promise<void> = Promise.resolve();

  constructor(private readonly config: ProtonMailConfig) {
    this.auditPath = join(this.config.dataDir, "audit.log");
    this.archivePath = `${this.auditPath}.1`;
  }

  getPath(): string {
    return this.auditPath;
  }

  async record(entry: AuditEntry): Promise<void> {
    await ensurePrivateDir(dirname(this.auditPath));
    const persistedEntry: AuditEntry = {
      ...entry,
      durationMs: entry.durationMs ?? 0,
      error: entry.error ? this.scrubError(entry.error) : entry.error,
    };
    await this.withRotateLock(async () => {
      await this.rotateIfNeeded();
      // WARNING: This audit log has no cryptographic integrity protection. Any process with filesystem access can tamper with or delete entries.
      await appendFile(this.auditPath, `${JSON.stringify(persistedEntry)}\n`, {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE,
      });
    });
  }

  async list(limit = 100): Promise<AuditEntry[]> {
    const cap = Math.min(limit, MAX_AUDIT_LINES);
    const entries = [...(await this.readEntries(this.archivePath, cap)), ...(await this.readEntries(this.auditPath, cap))];
    return entries.slice(-cap);
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const info = await stat(this.auditPath);
      if (info.size < MAX_AUDIT_BYTES) {
        return;
      }
      await rename(this.auditPath, this.archivePath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private async withRotateLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._rotateLock.then(fn, fn);
    this._rotateLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private scrubError(error: string): string {
    return String(error)
      .replace(/\b(password=)\S+/gi, "$1REDACTED")
      .replace(/:[^:@/\s]+@/g, ":REDACTED@");
  }

  private async readEntries(path: string, maxLines = MAX_AUDIT_LINES): Promise<AuditEntry[]> {
    try {
      const raw = await readFile(path, "utf8");
      const allLines = raw.split(/\r?\n/).filter(Boolean);
      const lines = allLines.slice(-maxLines);
      return lines.flatMap((line) => {
          try {
            return [JSON.parse(line) as AuditEntry];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }
  }
}
