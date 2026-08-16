import { isAbsolute } from "node:path";

export interface ScopePathKey {
  readonly normalized: string;
  readonly folded: string;
}

const windowsAbsolute = /^(?:[a-z]:[\\/]|\\\\)/iu;

export function scopePathKey(value: string): ScopePathKey {
  const normalized = value.normalize("NFC").trim().replaceAll("\\", "/")
    .replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (normalized === ".") return { normalized, folded: normalized };
  if (!normalized || isAbsolute(value) || windowsAbsolute.test(value)
    || normalized.startsWith("/") || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError(`Harness scope path is invalid: ${value}`);
  }
  return { normalized, folded: normalized.toLowerCase() };
}

export function scopeContains(parentValue: string, candidateValue: string): boolean {
  const parent = scopePathKey(parentValue).normalized;
  const candidate = scopePathKey(candidateValue).normalized;
  return parent === "." || candidate === parent || candidate.startsWith(`${parent}/`);
}

export function scopesMayOverlap(leftValue: string, rightValue: string): boolean {
  const left = scopePathKey(leftValue).folded;
  const right = scopePathKey(rightValue).folded;
  return left === "." || right === "." || left === right
    || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function minimalScopePaths(values: readonly string[]): string[] {
  const ordered = [...new Set(values.map((value) => scopePathKey(value).normalized))]
    .sort((left, right) => left.split("/").length - right.split("/").length
      || (left < right ? -1 : left > right ? 1 : 0));
  return ordered.filter((value, index) => !ordered.slice(0, index).some((root) => scopeContains(root, value)));
}
