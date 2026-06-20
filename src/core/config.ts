// Barrel — preserves existing import paths (from "../core/config.js" still works).
export * from "./config/schema.js";
export { loadConfig, isMissingConfigError, MISSING_CONFIG_MESSAGE } from "./config/load.js";
