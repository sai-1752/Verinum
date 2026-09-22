import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The directory that holds config/, migrations/ and assets/. Found by walking up from this module, so the
 * same code works from src/ (dev, tests), from dist/ (bundled), and inside the container image.
 */
let cached: string | undefined;
export function appRoot(): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "config", "plans.json"))) return (cached = dir);
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error("Could not locate the application root (config/plans.json not found above " + dirname(fileURLToPath(import.meta.url)) + ")");
}

export const appFile = (...segments: string[]) => join(appRoot(), ...segments);
