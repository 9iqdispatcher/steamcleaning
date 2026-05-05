#!/usr/bin/env node
import { exec as execCallback, spawn } from "node:child_process";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execCallback);

export class SteamRegistryCleaner {
  private readonly UNINSTALL_REG_PATHS = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];

  // oxlint-disable-next-line require-await
  private async runShell(command: string, args: string[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        stdio: "inherit",
        shell: false,
      });

      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Command failed with code ${code}`));
      });

      proc.on("error", reject);
    });
  }

  private async hasAdminRights(): Promise<boolean> {
    try {
      await exec("net session");
      return true;
    } catch {
      return false;
    }
  }

  private escapePsSingle(str: string): string {
    return str.replace(/'/g, "''");
  }

  // oxlint-disable-next-line require-await
  private async elevateProcess(): Promise<void> {
    console.log(
      "Administrator permissions required. Launching Windows Terminal elevated...",
    );

    const nodeExe = process.execPath;
    const scriptPath = process.argv[1];

    if (!scriptPath) {
      throw new Error("Unable to determine the script path for elevation.");
    }

    const args = process.argv.slice(2).filter((a) => a !== "--elevated");

    const innerArgs = [
      `'${this.escapePsSingle(nodeExe)}'`,
      `'${this.escapePsSingle(scriptPath)}'`,
      "--elevated",
      ...args.map((a) => `'${this.escapePsSingle(a)}'`),
    ].join(" ");

    const innerCommand = `& ${innerArgs}`;
    const wtArgs = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${innerCommand}"`;
    const psArgumentList = wtArgs.replace(/'/g, "''");

    const psCommand = `Start-Process wt.exe -Verb RunAs -ArgumentList '${psArgumentList}'`;

    return new Promise((resolve, reject) => {
      const child = spawn("powershell", ["-NoProfile", "-Command", psCommand], {
        stdio: "inherit",
      });

      child.on("close", (code) => {
        if (code !== 0) {
          console.warn(`Elevation process exited with code ${code}`);
        }
        resolve();
        process.exit(code ?? 0);
      });

      child.on("error", reject);
    });
  }

  private async checkEnvironment(): Promise<boolean> {
    if (os.platform() !== "win32") {
      throw new Error("This script is designed to run only on Windows.");
    }

    const isElevationAttempt = process.argv.includes("--elevated");
    const isAdmin = await this.hasAdminRights();

    if (!isAdmin && !isElevationAttempt) {
      await this.elevateProcess();
      return false;
    }

    if (isAdmin && !isElevationAttempt) {
      throw new Error(
        "Admin detected but script not started with --elevated flag. " +
          "Aborting to prevent unexpected behavior. Re-run from a non-admin terminal.",
      );
    }

    if (isElevationAttempt && !isAdmin) {
      throw new Error(
        "Started with --elevated flag but failed to gain admin rights. Aborting.",
      );
    }

    console.log("Running with administrator privileges in Windows Terminal.");
    return true;
  }

  private async findSteamAppEntries(): Promise<string[]> {
    console.log("\nSearching for Steam App entries in the registry...");
    const keysToDelete: string[] = [];

    for (const regPath of this.UNINSTALL_REG_PATHS) {
      try {
        const { stdout } = await exec(`reg query "${regPath}"`);
        const steamAppKeys = stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.includes("Steam App"));

        keysToDelete.push(...steamAppKeys);
      } catch {
        /* ignore */
      }
    }

    return keysToDelete;
  }

  public async run(): Promise<void> {
    try {
      const shouldContinue = await this.checkEnvironment();
      if (!shouldContinue) return;

      const keysToDelete = await this.findSteamAppEntries();

      if (keysToDelete.length === 0) {
        console.log("\nNo Steam App registry entries found to remove.");
        return;
      }

      console.log(
        `\nFound ${keysToDelete.length} registry entries that can be removed:\n`,
      );
      for (const key of keysToDelete) {
        console.log(`  - ${key}`);
      }

      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await rl.question(
        "\nDo you want to proceed with removing all of these entries? [y/N]: ",
      );
      rl.close();

      if (answer.trim().toLowerCase() !== "y") {
        console.log("\nOperation cancelled by user. Exiting.");
        return;
      }

      console.log("\nUser confirmed. Proceeding with removal...");
      let entriesRemoved = 0;

      for (const key of keysToDelete) {
        console.log(`  -> Removing: ${key}`);
        try {
          await this.runShell("reg", ["delete", key, "/f"]);
          entriesRemoved++;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`     Failed to remove ${key}: ${errMsg}`);
        }
      }

      console.log(
        `\nSuccessfully removed ${entriesRemoved} Steam App registry entries.`,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("\nAn error occurred during the script execution:", errMsg);
      process.exitCode = 1;
    } finally {
      if (process.argv.includes("--elevated")) {
        console.log("\nScript complete. Exiting in 5 seconds...");
        await setTimeout(5000);
      }
    }
  }
}

if (typeof process !== "undefined" && process.argv[1]) {
  const isMainModule = fileURLToPath(import.meta.url) === process.argv[1];
  if (isMainModule) {
    const cleaner = new SteamRegistryCleaner();
    cleaner.run();
  }
}
