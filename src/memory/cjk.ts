const cjkPattern = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const latinWordPattern = /[\p{L}\p{N}_-]{2,}/gu;

export function cjkNgrams(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const characters = Array.from(normalized);
  const grams = new Set<string>();
  let run: string[] = [];
  const flush = (): void => {
    for (const size of [2, 3]) {
      for (let index = 0; index + size <= run.length; index += 1) grams.add(run.slice(index, index + size).join(""));
    }
    run = [];
  };
  for (const character of characters) {
    if (cjkPattern.test(character)) run.push(character);
    else flush();
  }
  flush();
  return [...grams].sort();
}

export function memorySearchTerms(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const terms = new Set<string>(normalized.match(latinWordPattern) ?? []);
  for (const gram of cjkNgrams(normalized)) terms.add(gram);
  return [...terms].filter((term) => term.length <= 64).sort().slice(0, 64);
}

export function memoryCjkProjection(text: string): string {
  return cjkNgrams(text).join(" ");
}
