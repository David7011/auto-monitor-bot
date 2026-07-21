import { normalizeVehicleText } from "./vehicle-attributes.js";

type MakeAlias = {
  brand: string;
  aliases: string[];
};

const MAKES: MakeAlias[] = [
  { brand: "Acura", aliases: ["acura"] },
  { brand: "Alfa Romeo", aliases: ["alfa romeo"] },
  { brand: "Audi", aliases: ["audi"] },
  { brand: "BMW", aliases: ["bmw", "бмв"] },
  { brand: "BYD", aliases: ["byd"] },
  { brand: "Cadillac", aliases: ["cadillac"] },
  { brand: "Chery", aliases: ["chery"] },
  { brand: "Chevrolet", aliases: ["chevrolet", "шевроле"] },
  { brand: "Citroen", aliases: ["citroen", "citroen"] },
  { brand: "Dacia", aliases: ["dacia"] },
  { brand: "Daewoo", aliases: ["daewoo", "дэу"] },
  { brand: "Dodge", aliases: ["dodge"] },
  { brand: "Fiat", aliases: ["fiat"] },
  { brand: "Ford", aliases: ["ford"] },
  { brand: "Geely", aliases: ["geely"] },
  { brand: "Honda", aliases: ["honda"] },
  { brand: "Hyundai", aliases: ["hyundai", "хендай"] },
  { brand: "Infiniti", aliases: ["infiniti", "infinity"] },
  { brand: "Jaguar", aliases: ["jaguar"] },
  { brand: "Jeep", aliases: ["jeep"] },
  { brand: "Kia", aliases: ["kia"] },
  { brand: "Land Rover", aliases: ["land rover", "range rover"] },
  { brand: "Lexus", aliases: ["lexus"] },
  { brand: "Mazda", aliases: ["mazda"] },
  { brand: "Mercedes-Benz", aliases: ["mercedes benz", "mercedes", "mersedes", "mersedes bens", "мерседес"] },
  { brand: "Mini", aliases: ["mini"] },
  { brand: "Mitsubishi", aliases: ["mitsubishi", "мицубиси"] },
  { brand: "Nissan", aliases: ["nissan"] },
  { brand: "Opel", aliases: ["opel"] },
  { brand: "Peugeot", aliases: ["peugeot", "пежо"] },
  { brand: "Porsche", aliases: ["porsche"] },
  { brand: "Renault", aliases: ["renault", "рено"] },
  { brand: "SEAT", aliases: ["seat"] },
  { brand: "Skoda", aliases: ["skoda", "шкода"] },
  { brand: "Subaru", aliases: ["subaru"] },
  { brand: "Suzuki", aliases: ["suzuki"] },
  { brand: "Tesla", aliases: ["tesla"] },
  { brand: "Toyota", aliases: ["toyota", "тойота"] },
  { brand: "Volkswagen", aliases: ["volkswagen", "vw", "фольксваген"] },
  { brand: "Volvo", aliases: ["volvo"] },
  { brand: "ВАЗ / Lada", aliases: ["lada", "ваз", "vaz"] },
  { brand: "ЗАЗ", aliases: ["заз", "zaz"] },
];

const MODEL_TO_BRAND: Record<string, string> = {
  a3: "Audi",
  a4: "Audi",
  a5: "Audi",
  a6: "Audi",
  q3: "Audi",
  q5: "Audi",
  q7: "Audi",
  "1 series": "BMW",
  "2 series": "BMW",
  "3 series": "BMW",
  "4 series": "BMW",
  "5 series": "BMW",
  "5 серія": "BMW",
  x1: "BMW",
  x3: "BMW",
  x5: "BMW",
  x6: "BMW",
  astra: "Opel",
  insignia: "Opel",
  vectra: "Opel",
  zafira: "Opel",
  megane: "Renault",
  меган: "Renault",
  scenic: "Renault",
  kangoo: "Renault",
  logan: "Renault",
  camry: "Toyota",
  corolla: "Toyota",
  rav4: "Toyota",
  highlander: "Toyota",
  landcruiser: "Toyota",
  "land cruiser": "Toyota",
  golf: "Volkswagen",
  passat: "Volkswagen",
  tiguan: "Volkswagen",
  touareg: "Volkswagen",
  octavia: "Skoda",
  superb: "Skoda",
  fabia: "Skoda",
  civic: "Honda",
  accord: "Honda",
  "cr v": "Honda",
  elantra: "Hyundai",
  sonata: "Hyundai",
  tucson: "Hyundai",
  sportage: "Kia",
  sorento: "Kia",
  ceed: "Kia",
  focus: "Ford",
  mondeo: "Ford",
  kuga: "Ford",
  cx5: "Mazda",
  "cx 5": "Mazda",
  cx9: "Mazda",
  "cx 9": "Mazda",
  "model 3": "Tesla",
  "model y": "Tesla",
  leaf: "Nissan",
  qashqai: "Nissan",
  rogue: "Nissan",
};

export function normalizeBrandName(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeVehicleText(value);
  const match = MAKES.find((make) => make.aliases.some((alias) => normalized === normalizeVehicleText(alias)));
  return match?.brand ?? value.trim();
}

export function inferBrandFromText(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const normalized = normalizeVehicleText(text);
  const match = MAKES.find((make) => make.aliases.some((alias) => containsWordSequence(normalized, normalizeVehicleText(alias))));
  return match?.brand;
}

export function inferBrandFromModel(model: string | undefined | null): string | undefined {
  if (!model) return undefined;
  const normalized = normalizeVehicleText(model);
  return MODEL_TO_BRAND[normalized];
}

export function stripBrandFromTitle(title: string, brand: string | undefined): string | undefined {
  if (!brand) return undefined;
  const words = title.trim().split(/\s+/).filter(Boolean);
  const brandWords = normalizeVehicleText(brand).split(" ");

  for (let i = 0; i < words.length; i += 1) {
    const slice = words.slice(i, i + brandWords.length).join(" ");
    if (normalizeVehicleText(slice) === brandWords.join(" ")) {
      const rest = words.slice(i + brandWords.length).join(" ").trim();
      return rest || undefined;
    }
  }

  return undefined;
}

function containsWordSequence(text: string, phrase: string): boolean {
  if (!phrase) return false;
  return new RegExp(`(^|\\s)${escapeRegex(phrase)}($|\\s)`, "i").test(text);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
