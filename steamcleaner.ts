#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readdir, readFile, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

interface SteamLibrary {
  readonly path: string;
}

export interface NodeError extends Error {
  code?: string;
  errno?: number;
  syscall?: string;
  path?: string;
}

function isNodeError(error: unknown): error is NodeError {
  return (
    error instanceof Error && "code" in error && typeof error.code === "string"
  );
}

export class SteamLibraryCleaner {
  private ignorePatterns: string[] = ["steam", "config"];

  private getSteamInstallationPath(): string | null {
    try {
      if (process.platform === "win32") {
        const stdout = execSync(
          "reg query HKCU\\SOFTWARE\\Valve\\Steam /v SteamPath",
          {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
          },
        );

        const match = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/i);
        if (match && match[1]) {
          return match[1].trim();
        }
      } else if (
        process.platform === "linux" ||
        process.platform === "darwin"
      ) {
        const home = process.env["HOME"] || "";
        return process.platform === "linux"
          ? resolve(home, ".local/share/Steam")
          : resolve(home, "Library/Application Support/Steam");
      }
    } catch {
      console.warn(
        "Failed to retrieve Steam path from registry or environment.",
      );
    }
    return null;
  }

  private normalizePathKey(p: string): string {
    const normalized = resolve(p);

    return process.platform === "win32" || process.platform === "darwin"
      ? normalized.toLowerCase()
      : normalized;
  }

  private async getLibraries(steamPath: string): Promise<SteamLibrary[]> {
    const libraries = new Map<string, SteamLibrary>();

    const addLibrary = (p: string) => {
      const key = this.normalizePathKey(p);
      if (!libraries.has(key)) {
        libraries.set(key, { path: resolve(p) });
      }
    };

    addLibrary(steamPath);

    const vdfPath = join(steamPath, "steamapps", "libraryfolders.vdf");
    try {
      const vdfContent = await readFile(vdfPath, "utf-8");

      const pathRegex = /"path"\s+"([^"]+)"/g;
      let match: RegExpExecArray | null;

      while ((match = pathRegex.exec(vdfContent)) !== null) {
        if (match[1]) {
          const libPath = match[1].replace(/\\\\/g, "\\");
          addLibrary(libPath);
        }
      }
    } catch {
      console.warn(
        `Could not read ${vdfPath}, falling back to default library only.`,
      );
    }

    return Array.from(libraries.values());
  }

  private async loadStignore(): Promise<void> {
    const stignorePath = join(process.cwd(), ".stignore");

    try {
      const content = await readFile(stignorePath, "utf-8");
      const lines = content.split(/\r?\n/);
      let addedCount = 0;

      for (const line of lines) {
        const pattern = line.trim().toLowerCase();
        if (pattern && !this.ignorePatterns.includes(pattern)) {
          this.ignorePatterns.push(pattern);
          addedCount++;
        }
      }

      if (addedCount > 0) {
        console.log(
          `Loaded ${addedCount} custom ignore pattern(s) from .stignore.`,
        );
      }
    } catch (err) {
      if (isNodeError(err) && err?.code !== "ENOENT") {
        console.warn(`Warning: Could not parse .stignore: ${err.message}`);
      }
    }
  }

  private async findJunkFoldersInLibrary(
    library: SteamLibrary,
  ): Promise<string[]> {
    const steamAppsDir = join(library.path, "steamapps");
    const commonDir = join(steamAppsDir, "common");
    const junkFolders: string[] = [];

    try {
      const commonStats = await stat(commonDir);
      if (!commonStats.isDirectory()) return [];
    } catch {
      return [];
    }

    const installedAppDirs = new Set<string>();

    try {
      const files = await readdir(steamAppsDir);
      for (const file of files) {
        if (
          file.toLowerCase().startsWith("appmanifest_") &&
          file.toLowerCase().endsWith(".acf")
        ) {
          try {
            const content = await readFile(join(steamAppsDir, file), "utf-8");
            const match = content.match(/"installdir"\s+"([^"]+)"/i);
            if (match && match[1]) {
              installedAppDirs.add(match[1].toLowerCase());
            }
          } catch {
            /* ignore */
          }
        }
      }

      const commonDirs = await readdir(commonDir, { withFileTypes: true });
      for (const dirEntry of commonDirs) {
        if (dirEntry.isDirectory()) {
          const dirName = dirEntry.name;
          const lowerName = dirName.toLowerCase();

          const isIgnored = this.ignorePatterns.some((pattern) =>
            lowerName.includes(pattern),
          );
          if (isIgnored) {
            continue;
          }

          if (!installedAppDirs.has(lowerName)) {
            junkFolders.push(join(commonDir, dirName));
          }
        }
      }
    } catch (err) {
      console.error(`Error scanning library ${library.path}:`, err);
    }

    return junkFolders;
  }

  private async promptForDeletion(junkFolders: string[]): Promise<void> {
    if (junkFolders.length === 0) {
      console.log("\nNo junk folders found! Your libraries are clean.");
      return;
    }

    console.log(
      `\nFound ${junkFolders.length} potentially orphaned game folder(s):\n`,
    );
    junkFolders.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    console.log("\nStarting cleanup process...\n");

    const rl = createInterface({ input, output });

    try {
      for (const folder of junkFolders) {
        const answer = await rl.question(
          `Delete headless folder: "${folder}"? [y/N]: `,
        );

        if (answer.trim().toLowerCase() === "y") {
          try {
            await rm(folder, { recursive: true, force: true });
            console.log(`  -> Deleted: ${folder}\n`);
          } catch (err) {
            const errMessage = err instanceof Error ? err.message : String(err);
            console.error(`  -> Failed to delete ${folder}: ${errMessage}\n`);
          }
        } else {
          console.log(`  -> Skipped: ${folder}\n`);
        }
      }
    } finally {
      rl.close();
      console.log("Cleanup finished.");
    }
  }

  public async run(): Promise<void> {
    console.log("Initializing Steam Library Cleaner...");

    await this.loadStignore();

    const steamPath = this.getSteamInstallationPath();
    if (!steamPath) {
      console.error("Could not locate Steam installation on this machine.");
      process.exit(1);
    }

    const libraries = await this.getLibraries(steamPath);
    console.log(
      `Discovered ${libraries.length} unique Steam Librar${libraries.length > 1 ? "ies" : "y"}.`,
    );

    const allJunkFolders: string[] = [];

    for (const library of libraries) {
      const junk = await this.findJunkFoldersInLibrary(library);
      allJunkFolders.push(...junk);
    }

    await this.promptForDeletion(allJunkFolders);
  }
}

if (typeof process !== "undefined" && process.argv[1]) {
  const isMainModule = fileURLToPath(import.meta.url) === process.argv[1];
  if (isMainModule) {
    const cleaner = new SteamLibraryCleaner();
    cleaner.run().catch((err) => {
      console.error("Fatal error encountered:", err);
      process.exit(1);
    });
  }
}
