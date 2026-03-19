export const CATEGORIES = {
  general:    9,
  science:    17,
  geography:  22,
  history:    23,
  sports:     21,
  music:      12,
  film:       11,
  computers:  18,
  mythology:  20,
  animals:    27,
};

export const CATEGORY_NAMES = Object.keys(CATEGORIES);

export const DIFFICULTIES = ["easy", "medium", "hard"];

export function categoryIdFor(name) {
  if (!name || name === "any" || name === "random") return null;
  return CATEGORIES[name.toLowerCase()] ?? null;
}
