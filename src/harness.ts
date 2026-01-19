/**
 * Harness for invoking .NET methods without a full debug session.
 */

import * as path from "path";
import * as fs from "fs";
import { spawnSync, spawn } from "child_process";

// Get harness path relative to this file
const harnessDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "harness"
);

export const harnessDll = path.join(
  harnessDir,
  "bin",
  "Debug",
  "net8.0",
  "McpNetcoreDbg.Harness.dll"
);

export interface InvokeResult {
  success: boolean;
  method?: string;
  args?: unknown[];
  returnType?: string;
  returnValue?: unknown;
  durationMs?: number;
  logs?: Array<{ level: string; message: string; category?: string }>;
  stdout?: string;
  error?: string;
  errorDetails?: {
    type?: string;
    reason?: string;
    constructors?: Array<{ params: string[] }>;
    methods?: Array<{
      name: string;
      params: string[];
      returnType: string;
      isStatic: boolean;
    }>;
    stackTrace?: string;
  };
}

/**
 * Build harness if it doesn't exist.
 */
export async function ensureHarnessBuilt(): Promise<{ success: boolean; error?: string }> {
  if (fs.existsSync(harnessDll)) {
    return { success: true };
  }

  const csproj = path.join(harnessDir, "McpNetcoreDbg.Harness.csproj");
  if (!fs.existsSync(csproj)) {
    return {
      success: false,
      error: `Harness project not found at ${harnessDir}. Please ensure the MCP server is installed correctly.`,
    };
  }

  const result = spawnSync("dotnet", ["build", "-c", "Debug"], {
    cwd: harnessDir,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    return {
      success: false,
      error: `Failed to build harness: ${result.stderr || result.stdout}`,
    };
  }

  return { success: true };
}

/**
 * Run harness with given request JSON.
 */
export async function runHarness(requestJson: string): Promise<InvokeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("dotnet", [harnessDll, requestJson], {
      cwd: harnessDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", () => {
      try {
        const result = JSON.parse(stdout) as InvokeResult;
        resolve(result);
      } catch {
        resolve({
          success: false,
          error: `Failed to parse harness output: ${stdout || stderr}`,
          errorDetails: { reason: stderr || "Unknown error" },
        });
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}
