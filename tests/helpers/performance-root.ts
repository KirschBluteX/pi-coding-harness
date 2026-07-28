import { join, resolve } from "node:path";

export interface DeclaredPerformanceRoot {
  readonly dataRoot: string;
  readonly dataRootSource: "PCH_PERFORMANCE_DATA_ROOT";
  readonly epochRoot: string;
}

export function declaredPerformanceRoot(phase: string): DeclaredPerformanceRoot {
  if (!/^[a-z0-9-]+$/u.test(phase)) throw new TypeError(`Invalid performance phase: ${phase}`);
  const configured = process.env.PCH_PERFORMANCE_DATA_ROOT?.trim();
  if (!configured) {
    throw new TypeError("PCH_PERFORMANCE_DATA_ROOT must declare the project or deployment data-root volume");
  }
  const dataRoot = resolve(configured);
  return {
    dataRoot,
    dataRootSource: "PCH_PERFORMANCE_DATA_ROOT",
    epochRoot: join(dataRoot, ".performance-epochs", phase),
  };
}
