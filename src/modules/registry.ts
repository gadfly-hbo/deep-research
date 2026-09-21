import { brandConfig } from "./brand.js";
import { industryConfig } from "./industry.js";
import type { ModuleConfig } from "./types.js";

export function getModuleConfig(module: "brand" | "industry"): ModuleConfig {
  return module === "brand" ? brandConfig : industryConfig;
}
