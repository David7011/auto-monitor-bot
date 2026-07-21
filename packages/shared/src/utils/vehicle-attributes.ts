export type VehicleAttributeOption = {
  value: string;
  label: string;
  aliases: string[];
};

export const BODY_TYPE_OPTIONS: VehicleAttributeOption[] = [
  { value: "sedan", label: "Седан", aliases: ["седан", "sedan"] },
  { value: "wagon", label: "Универсал", aliases: ["универсал", "touring", "avant", "variant", "wagon"] },
  { value: "hatchback", label: "Хэтчбек", aliases: ["хэтчбек", "хетчбек", "hatchback", "liftback"] },
  { value: "suv", label: "Внедорожник / кроссовер", aliases: ["внедорожник", "кроссовер", "позашляховик", "suv", "crossover"] },
  { value: "coupe", label: "Купе", aliases: ["купе", "coupe"] },
  { value: "convertible", label: "Кабриолет", aliases: ["кабриолет", "кабріолет", "convertible", "cabrio"] },
  { value: "minivan", label: "Минивэн", aliases: ["минивэн", "мінівен", "minivan", "mpv"] },
  { value: "pickup", label: "Пикап", aliases: ["пикап", "пікап", "pickup"] },
  { value: "van", label: "Фургон", aliases: ["фургон", "van"] },
];

export const FUEL_TYPE_OPTIONS: VehicleAttributeOption[] = [
  { value: "gasoline", label: "Бензин", aliases: ["бензин", "gasoline", "petrol"] },
  { value: "diesel", label: "Дизель", aliases: ["дизель", "diesel"] },
  { value: "gas", label: "Газ / бензин", aliases: ["газ / бензин", "газ-бензин", "газ бензин", "гбо", "gas"] },
  { value: "hybrid", label: "Гибрид", aliases: ["гибрид", "гібрид", "hybrid"] },
  { value: "electric", label: "Электро", aliases: ["электро", "електро", "электромобиль", "електромобіль", "electric", "ev"] },
];

export const GEARBOX_OPTIONS: VehicleAttributeOption[] = [
  { value: "manual", label: "Механика", aliases: ["механика", "механічна", "механическая", "manual", "мкпп"] },
  { value: "automatic", label: "Автомат", aliases: ["автомат", "автоматична", "автоматическая", "automatic", "акпп"] },
  { value: "robot", label: "Робот", aliases: ["робот", "роботизированная", "robot", "dsg"] },
  { value: "variator", label: "Вариатор", aliases: ["вариатор", "варіатор", "cvt", "variator"] },
];

export const DRIVE_TYPE_OPTIONS: VehicleAttributeOption[] = [
  { value: "front", label: "Передний", aliases: ["передний", "передній", "front", "fwd"] },
  { value: "rear", label: "Задний", aliases: ["задний", "задній", "rear", "rwd"] },
  { value: "all", label: "Полный", aliases: ["полный", "повний", "полный привод", "повний привід", "all wheel", "awd", "4wd", "xdrive", "quattro", "4matic"] },
];

export function normalizeVehicleText(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/ї/g, "і")
    .replace(/[\s_./\\-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type NormalizedOption = { value: string; aliases: string[] };

// Aliases are static, so normalize them once per options array (keyed by the
// stable module constants) instead of on every per-listing call.
const normalizedOptionCache = new WeakMap<VehicleAttributeOption[], NormalizedOption[]>();

function normalizedOptions(options: VehicleAttributeOption[]): NormalizedOption[] {
  let cached = normalizedOptionCache.get(options);
  if (!cached) {
    cached = options.map((option) => ({
      value: option.value,
      // Longest-first so the most specific alias wins the tie-break below.
      aliases: [...new Set(option.aliases.map(normalizeVehicleText).filter(Boolean))].sort((a, b) => b.length - a.length),
    }));
    normalizedOptionCache.set(options, cached);
  }
  return cached;
}

export function findAttributeValue(value: string | undefined | null, options: VehicleAttributeOption[]): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeVehicleText(value);
  if (!normalized) return undefined;

  // Pick the option whose matched alias is the most specific (longest), so a
  // dual-fuel "газ бензин" is not shadowed by the shorter "бензин" of gasoline.
  let best: { value: string; length: number } | undefined;
  for (const option of normalizedOptions(options)) {
    if (option.value === normalized) return option.value;
    for (const alias of option.aliases) {
      if (normalized.includes(alias)) {
        if (!best || alias.length > best.length) best = { value: option.value, length: alias.length };
        break;
      }
    }
  }

  return best?.value;
}

export function inferVehicleAttributes(text: string): {
  bodyType?: string;
  fuelType?: string;
  gearbox?: string;
  driveType?: string;
} {
  return {
    bodyType: findAttributeValue(text, BODY_TYPE_OPTIONS),
    fuelType: findAttributeValue(text, FUEL_TYPE_OPTIONS),
    gearbox: findAttributeValue(text, GEARBOX_OPTIONS),
    driveType: findAttributeValue(text, DRIVE_TYPE_OPTIONS),
  };
}

export function vehicleAttributeMatches(
  selected: string[],
  listingValue: string | undefined | null,
  haystack: string,
  options: VehicleAttributeOption[],
): boolean {
  if (selected.length === 0) return true;

  const selectedSet = new Set(selected.map((value) => normalizeVehicleText(value)));
  const normalizedListingValue = findAttributeValue(listingValue, options);
  if (normalizedListingValue && selectedSet.has(normalizedVehicleValue(normalizedListingValue))) return true;

  const inferredValue = findAttributeValue(haystack, options);
  return inferredValue ? selectedSet.has(normalizedVehicleValue(inferredValue)) : false;
}

function normalizedVehicleValue(value: string): string {
  return normalizeVehicleText(value);
}
