import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodingHarness } from "./bridge/register.js";

export default function codingHarnessExtension(pi: ExtensionAPI): void {
  registerCodingHarness(pi);
}

export { registerCodingHarness } from "./bridge/register.js";
export type { CodingHarnessBridgeOptions } from "./bridge/register.js";
export { loadConfig } from "./config/load-config.js";
export type { CodingHarnessConfig } from "./config/types.js";
