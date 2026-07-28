import { AuthorityIntegrityError } from "../foundation/errors.js";

export interface SqliteWalRuntimeSupport {
  readonly version: string | null;
  readonly safe: boolean;
  readonly requirement: string;
}

const requirement = "SQLite 3.51.3+ (or fixed backports 3.50.7+/3.44.6+)";

function parsed(version: string | undefined): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\D.*)?$/u.exec(version ?? "");
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function sqliteWalRuntimeSupport(version: string | undefined = process.versions.sqlite): SqliteWalRuntimeSupport {
  const parts = parsed(version);
  if (!parts) return { version: version ?? null, safe: false, requirement };
  const [major, minor, patch] = parts;
  const safe = major > 3
    || (major === 3 && (minor > 51
      || (minor === 51 && patch >= 3)
      || (minor === 50 && patch >= 7)
      || (minor === 44 && patch >= 6)));
  return { version: version ?? null, safe, requirement };
}

export function assertWalRuntimeSafe(version: string | undefined = process.versions.sqlite): void {
  const support = sqliteWalRuntimeSupport(version);
  if (support.safe) return;
  throw new AuthorityIntegrityError(
    `Embedded SQLite ${support.version ?? "unavailable"} is affected by the WAL-reset corruption risk; ${support.requirement} is required`,
  );
}
