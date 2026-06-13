import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { REPO_PATH } from "./config.js";

export interface ConductorSettings {
  defaultModel?: string;
  defaultBaseBranch?: string;
  branchPresets?: Record<string, string>;
  maxConcurrentAgents?: number;
  systemPrompt?: string;
}

const SETTINGS_PATH = join(REPO_PATH, ".conductor", "settings.json");

function load(): ConductorSettings {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as ConductorSettings;
  } catch (e) {
    console.warn(`[conductor] Failed to parse ${SETTINGS_PATH}: ${e} — using defaults`);
    return {};
  }
}

export const conductorSettings: ConductorSettings = load();
