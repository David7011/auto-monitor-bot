import { GENERATED_UKRAINE_CITIES, UKRAINE_CITIES_DATA_VERSION } from "./ukraine-cities.generated.js";

export type City = {
  id: string;
  regionId: string;
  nameUk: string;
  nameRu: string;
  aliases: string[];
  autoRiaCityId?: number;
};

export type Region = {
  id: string;
  nameUk: string;
  nameRu: string;
  aliases: string[];
  autoRiaStateId?: number;
  cities: City[];
};

export type AutoRiaGeoParam = {
  regionId: string;
  cityId: string | null;
  stateId: number;
  cityIdValue: number;
  apiCityBacked: boolean;
};

const AUTO_RIA_STATE_ID_BY_REGION_ID: Partial<Record<string, number>> = {
  "kyiv-city": 10,
  vinnytska: 1,
  volynska: 18,
  dnipropetrovska: 11,
  donetska: 13,
  zhytomyrska: 2,
  zakarpatska: 22,
  zaporizka: 14,
  "ivano-frankivska": 15,
  kyivska: 10,
  kirovohradska: 16,
  luhanska: 17,
  lvivska: 5,
  mykolaivska: 19,
  odeska: 12,
  poltavska: 20,
  rivnenska: 9,
  sumska: 8,
  ternopilska: 3,
  kharkivska: 7,
  khersonska: 23,
  khmelnytska: 4,
  cherkaska: 24,
  chernihivska: 6,
  chernivetska: 25,
  crimea: 21,
};

const AUTO_RIA_CITY_ID_BY_CITY_ID: Partial<Record<string, number>> = {
  dnipro: 11,
  kamianske: 72,
  "kryvyi-rih": 76,
  vinnytsia: 1,
  zhmerynka: 27,
  "mohyliv-podilskyi": 34,
};

export const UKRAINE_REGIONS: Region[] = [
  region("kyiv-city", "Київ", "Киев", ["київ", "киев", "kyiv", "kiev", "м. київ"], [
    city("kyiv", "Київ", "Киев", ["kyiv", "kiev"]),
  ]),
  region("vinnytska", "Вінницька область", "Винницкая область", ["вінницька", "винницкая", "vinnytsia"], [
    city("vinnytsia", "Вінниця", "Винница", ["vinnytsia", "vinnitsa"]),
    city("zhmerynka", "Жмеринка", "Жмеринка", ["zhmerynka"]),
    city("mohyliv-podilskyi", "Могилів-Подільський", "Могилев-Подольский", ["mohyliv podilskyi"]),
  ]),
  region("volynska", "Волинська область", "Волынская область", ["волинська", "волынская", "volyn"], [
    city("lutsk", "Луцьк", "Луцк", ["lutsk"]),
    city("kovel", "Ковель", "Ковель", ["kovel"]),
    city("volodymyr", "Володимир", "Владимир", ["volodymyr", "vladimir-volynskiy"]),
  ]),
  region("dnipropetrovska", "Дніпропетровська область", "Днепропетровская область", ["дніпропетровська", "днепропетровская", "dnepr", "dnipro"], [
    city("dnipro", "Дніпро", "Днепр", ["dnepr", "dnipro", "дніпропетровськ", "днепропетровск"]),
    city("kryvyi-rih", "Кривий Ріг", "Кривой Рог", ["krivoy rog", "kryvyi rih"]),
    city("kamianske", "Кам'янське", "Каменское", ["dneprodzerzhinsk", "дніпродзержинськ", "днепродзержинск"]),
    city("nikopol", "Нікополь", "Никополь", ["nikopol"]),
    city("pavlohrad", "Павлоград", "Павлоград", ["pavlograd"]),
  ]),
  region("donetska", "Донецька область", "Донецкая область", ["донецька", "донецкая", "donetsk"], [
    city("donetsk", "Донецьк", "Донецк", ["donetsk"]),
    city("mariupol", "Маріуполь", "Мариуполь", ["mariupol"]),
    city("kramatorsk", "Краматорськ", "Краматорск", ["kramatorsk"]),
    city("sloviansk", "Слов'янськ", "Славянск", ["slavyansk", "sloviansk"]),
  ]),
  region("zhytomyrska", "Житомирська область", "Житомирская область", ["житомирська", "житомирская", "zhytomyr"], [
    city("zhytomyr", "Житомир", "Житомир", ["zhytomyr", "zhitomir"]),
    city("berdychiv", "Бердичів", "Бердичев", ["berdychiv"]),
    city("korosten", "Коростень", "Коростень", ["korosten"]),
  ]),
  region("zakarpatska", "Закарпатська область", "Закарпатская область", ["закарпатська", "закарпатская", "uzhhorod", "zakarpattya"], [
    city("uzhhorod", "Ужгород", "Ужгород", ["uzhhorod", "uzhgorod"]),
    city("mukachevo", "Мукачево", "Мукачево", ["mukachevo"]),
    city("khust", "Хуст", "Хуст", ["khust"]),
  ]),
  region("zaporizka", "Запорізька область", "Запорожская область", ["запорізька", "запорожская", "zaporizhzhia"], [
    city("zaporizhzhia", "Запоріжжя", "Запорожье", ["zaporizhzhia", "zaporozhye"]),
    city("melitopol", "Мелітополь", "Мелитополь", ["melitopol"]),
    city("berdiansk", "Бердянськ", "Бердянск", ["berdiansk", "berdyansk"]),
  ]),
  region("ivano-frankivska", "Івано-Франківська область", "Ивано-Франковская область", ["івано-франківська", "ивано-франковская", "frankivsk"], [
    city("ivano-frankivsk", "Івано-Франківськ", "Ивано-Франковск", ["ivano-frankivsk", "frankivsk"]),
    city("kolomyia", "Коломия", "Коломыя", ["kolomyia"]),
    city("kalush", "Калуш", "Калуш", ["kalush"]),
  ]),
  region("kyivska", "Київська область", "Киевская область", ["київська", "киевская", "kyiv oblast"], [
    city("bila-tserkva", "Біла Церква", "Белая Церковь", ["bila tserkva", "belaya tserkov"]),
    city("brovary", "Бровари", "Бровары", ["brovary"]),
    city("boryspil", "Бориспіль", "Борисполь", ["boryspil", "borispol"]),
    city("irpin", "Ірпінь", "Ирпень", ["irpin"]),
    city("bucha", "Буча", "Буча", ["bucha"]),
  ]),
  region("kirovohradska", "Кіровоградська область", "Кировоградская область", ["кіровоградська", "кировоградская", "kropyvnytskyi"], [
    city("kropyvnytskyi", "Кропивницький", "Кропивницкий", ["kirovohrad", "kirovograd", "kropyvnytskyi"]),
    city("oleksandriia", "Олександрія", "Александрия", ["oleksandriia", "alexandria"]),
    city("svitlovodsk", "Світловодськ", "Светловодск", ["svitlovodsk"]),
  ]),
  region("luhanska", "Луганська область", "Луганская область", ["луганська", "луганская", "luhansk", "lugansk"], [
    city("luhansk", "Луганськ", "Луганск", ["lugansk", "luhansk"]),
    city("sievierodonetsk", "Сєвєродонецьк", "Северодонецк", ["severodonetsk", "sievierodonetsk"]),
    city("lysychansk", "Лисичанськ", "Лисичанск", ["lysychansk"]),
  ]),
  region("lvivska", "Львівська область", "Львовская область", ["львівська", "львовская", "lviv"], [
    city("lviv", "Львів", "Львов", ["lviv", "lvov", "lwow"]),
    city("drohobych", "Дрогобич", "Дрогобыч", ["drohobych"]),
    city("stryi", "Стрий", "Стрый", ["stryi"]),
    city("chervonohrad", "Червоноград", "Червоноград", ["chervonohrad"]),
  ]),
  region("mykolaivska", "Миколаївська область", "Николаевская область", ["миколаївська", "николаевская", "mykolaiv"], [
    city("mykolaiv", "Миколаїв", "Николаев", ["mykolaiv", "nikolaev"]),
    city("pervomaisk-mykolaiv", "Первомайськ", "Первомайск", ["pervomaisk"]),
    city("voznesensk", "Вознесенськ", "Вознесенск", ["voznesensk"]),
  ]),
  region("odeska", "Одеська область", "Одесская область", ["одеська", "одесская", "odesa", "odessa"], [
    city("odesa", "Одеса", "Одесса", ["odesa", "odessa"]),
    city("chornomorsk", "Чорноморськ", "Черноморск", ["illichivsk", "ильичевск", "chornomorsk"]),
    city("izmail", "Ізмаїл", "Измаил", ["izmail"]),
    city("bilhorod-dnistrovskyi", "Білгород-Дністровський", "Белгород-Днестровский", ["belgorod-dnestrovsky"]),
  ]),
  region("poltavska", "Полтавська область", "Полтавская область", ["полтавська", "полтавская", "poltava"], [
    city("poltava", "Полтава", "Полтава", ["poltava"]),
    city("kremenchuk", "Кременчук", "Кременчуг", ["kremenchuk", "kremenchug"]),
    city("lubny", "Лубни", "Лубны", ["lubny"]),
  ]),
  region("rivnenska", "Рівненська область", "Ровенская область", ["рівненська", "ровенская", "rivne"], [
    city("rivne", "Рівне", "Ровно", ["rivne", "rovno"]),
    city("dubno", "Дубно", "Дубно", ["dubno"]),
    city("varash", "Вараш", "Вараш", ["varash", "kuznetsovsk"]),
  ]),
  region("sumska", "Сумська область", "Сумская область", ["сумська", "сумская", "sumy"], [
    city("sumy", "Суми", "Сумы", ["sumy"]),
    city("konotop", "Конотоп", "Конотоп", ["konotop"]),
    city("okhtyrka", "Охтирка", "Ахтырка", ["okhtyrka", "akhtyrka"]),
  ]),
  region("ternopilska", "Тернопільська область", "Тернопольская область", ["тернопільська", "тернопольская", "ternopil"], [
    city("ternopil", "Тернопіль", "Тернополь", ["ternopil"]),
    city("chortkiv", "Чортків", "Чортков", ["chortkiv"]),
    city("kremenets", "Кременець", "Кременец", ["kremenets"]),
  ]),
  region("kharkivska", "Харківська область", "Харьковская область", ["харківська", "харьковская", "kharkiv"], [
    city("kharkiv", "Харків", "Харьков", ["kharkiv", "kharkov"]),
    city("lozova", "Лозова", "Лозовая", ["lozova"]),
    city("izium", "Ізюм", "Изюм", ["izium", "izyum"]),
  ]),
  region("khersonska", "Херсонська область", "Херсонская область", ["херсонська", "херсонская", "kherson"], [
    city("kherson", "Херсон", "Херсон", ["kherson"]),
    city("nova-kakhovka", "Нова Каховка", "Новая Каховка", ["nova kakhovka"]),
    city("skadovsk", "Скадовськ", "Скадовск", ["skadovsk"]),
  ]),
  region("khmelnytska", "Хмельницька область", "Хмельницкая область", ["хмельницька", "хмельницкая", "khmelnytskyi"], [
    city("khmelnytskyi", "Хмельницький", "Хмельницкий", ["khmelnytskyi", "khmelnitsky"]),
    city("kamianets-podilskyi", "Кам'янець-Подільський", "Каменец-Подольский", ["kamianets podilskyi"]),
    city("shepetivka", "Шепетівка", "Шепетовка", ["shepetivka"]),
  ]),
  region("cherkaska", "Черкаська область", "Черкасская область", ["черкаська", "черкасская", "cherkasy"], [
    city("cherkasy", "Черкаси", "Черкассы", ["cherkasy", "cherkassy"]),
    city("uman", "Умань", "Умань", ["uman"]),
    city("smila", "Сміла", "Смела", ["smila"]),
  ]),
  region("chernivetska", "Чернівецька область", "Черновицкая область", ["чернівецька", "черновицкая", "chernivtsi"], [
    city("chernivtsi", "Чернівці", "Черновцы", ["chernivtsi", "chernovtsy"]),
    city("khotyn", "Хотин", "Хотин", ["khotyn"]),
    city("storozhynets", "Сторожинець", "Сторожинец", ["storozhynets"]),
  ]),
  region("chernihivska", "Чернігівська область", "Черниговская область", ["чернігівська", "черниговская", "chernihiv"], [
    city("chernihiv", "Чернігів", "Чернигов", ["chernihiv", "chernigov"]),
    city("nizhyn", "Ніжин", "Нежин", ["nizhyn", "nezhin"]),
    city("pryluky", "Прилуки", "Прилуки", ["pryluky"]),
  ]),
  region("crimea", "Автономна Республіка Крим", "Автономная Республика Крым", ["крим", "крым", "crimea"], [
    city("simferopol", "Сімферополь", "Симферополь", ["simferopol"]),
    city("sevastopol", "Севастополь", "Севастополь", ["sevastopol"]),
    city("yalta", "Ялта", "Ялта", ["yalta"]),
  ]),
];

const GENERATED_CITY_OVERRIDES: Record<string, { nameRu: string; aliases: string[] }> = {
  "katottg-ua12100070010038698": {
    nameRu: "Самар",
    aliases: ["Самар", "Новомосковськ", "Новомосковск", "novomoskovsk", "samar"],
  },
};

for (const [id, regionId, nameUk] of GENERATED_UKRAINE_CITIES) {
  const regionItem = UKRAINE_REGIONS.find((item) => item.id === regionId);
  if (!regionItem) continue;
  const officialToken = normalizeGeoText(nameUk);
  const alreadyIncluded = regionItem.cities.some((cityItem) =>
    geoTokens(cityItem.id, cityItem.nameUk, cityItem.nameRu, cityItem.aliases).includes(officialToken),
  );
  if (alreadyIncluded) continue;

  const override = GENERATED_CITY_OVERRIDES[id];
  regionItem.cities.push({
    id,
    regionId,
    nameUk,
    nameRu: override?.nameRu ?? nameUk,
    aliases: override?.aliases ?? ukrainianSearchAliases(nameUk),
  });
}

for (const regionItem of UKRAINE_REGIONS) {
  regionItem.cities.sort((left, right) => left.nameUk.localeCompare(right.nameUk, "uk"));
}

export { UKRAINE_CITIES_DATA_VERSION };

const REGION_BY_ID = new Map(UKRAINE_REGIONS.map((item) => [item.id, item]));
const CITY_BY_ID = new Map(UKRAINE_REGIONS.flatMap((item) => item.cities.map((cityItem) => [cityItem.id, cityItem] as const)));
const REGION_TOKEN_TO_ID = new Map<string, string>();
const CITY_TOKEN_TO_ID = new Map<string, string>();

for (const item of UKRAINE_REGIONS) {
  for (const token of geoTokens(item.id, item.nameUk, item.nameRu, item.aliases)) {
    REGION_TOKEN_TO_ID.set(token, item.id);
  }
  for (const cityItem of item.cities) {
    for (const token of geoTokens(cityItem.id, cityItem.nameUk, cityItem.nameRu, cityItem.aliases)) {
      CITY_TOKEN_TO_ID.set(token, cityItem.id);
    }
  }
}

export function normalizeRegionIds(values: readonly string[] | null | undefined): string[] {
  return unique((values ?? []).map((value) => resolveRegionId(value)).filter(Boolean));
}

export function normalizeCityIds(
  values: readonly string[] | null | undefined,
  allowedRegionIds: readonly string[] = [],
): string[] {
  const allowed = new Set(allowedRegionIds);
  return unique(
    (values ?? [])
      .map((value) => resolveCityId(value))
      .filter((cityId) => {
        if (!cityId) return false;
        if (allowed.size === 0) return true;
        const cityItem = CITY_BY_ID.get(cityId);
        return cityItem ? allowed.has(cityItem.regionId) : false;
      }),
  );
}

export function resolveRegionId(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const direct = REGION_BY_ID.get(value);
  if (direct) return direct.id;
  return REGION_TOKEN_TO_ID.get(normalizeGeoText(value));
}

export function resolveCityId(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const direct = CITY_BY_ID.get(value);
  if (direct) return direct.id;
  return CITY_TOKEN_TO_ID.get(normalizeGeoText(value));
}

export function listingMatchesGeoSelection(
  listing: { region?: string | null; city?: string | null },
  selectedRegionIds: readonly string[] = [],
  selectedCityIds: readonly string[] = [],
): boolean {
  const regionIds = normalizeRegionIds(selectedRegionIds);
  const cityIds = normalizeCityIds(selectedCityIds);
  if (regionIds.length === 0 && cityIds.length === 0) return true;

  const listingCityId = resolveCityId(listing.city);
  const listingCity = listingCityId ? CITY_BY_ID.get(listingCityId) : undefined;
  const listingRegionId = resolveRegionId(listing.region) ?? listingCity?.regionId;

  if (listingCityId && cityIds.includes(listingCityId)) return true;
  if (!listingRegionId || !regionIds.includes(listingRegionId)) return false;

  const selectedCitiesInListingRegion = cityIds.filter((cityId) => CITY_BY_ID.get(cityId)?.regionId === listingRegionId);
  return selectedCitiesInListingRegion.length === 0;
}

export function getRegionById(id: string): Region | undefined {
  return REGION_BY_ID.get(id);
}

export function getCityById(id: string): City | undefined {
  return CITY_BY_ID.get(id);
}

export function cityIdsForRegions(regionIds: readonly string[]): string[] {
  const selected = new Set(regionIds);
  if (selected.size === 0) return Array.from(CITY_BY_ID.keys());
  return UKRAINE_REGIONS.filter((item) => selected.has(item.id)).flatMap((item) => item.cities.map((cityItem) => cityItem.id));
}

export function autoRiaGeoParamsForSelection(
  selectedRegionIds: readonly string[] = [],
  selectedCityIds: readonly string[] = [],
): AutoRiaGeoParam[] {
  const regionIds = normalizeRegionIds(selectedRegionIds);
  const cityIds = normalizeCityIds(selectedCityIds, regionIds);
  const result: AutoRiaGeoParam[] = [];
  const seen = new Set<string>();

  const appendCityParam = (cityId: string) => {
    const cityItem = CITY_BY_ID.get(cityId);
    if (!cityItem) return;
    const regionItem = REGION_BY_ID.get(cityItem.regionId);
    if (!regionItem?.autoRiaStateId) return;
    const cityIdValue = cityItem.autoRiaCityId ?? 0;
    const key = `${regionItem.autoRiaStateId}:${cityIdValue}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({
      regionId: regionItem.id,
      cityId: cityItem.id,
      stateId: regionItem.autoRiaStateId,
      cityIdValue,
      apiCityBacked: Boolean(cityItem.autoRiaCityId),
    });
  };

  if (regionIds.length === 0) {
    for (const cityId of cityIds) appendCityParam(cityId);
    return result;
  }

  for (const regionId of regionIds) {
    const selectedCitiesInRegion = cityIds.filter((cityId) => CITY_BY_ID.get(cityId)?.regionId === regionId);
    if (selectedCitiesInRegion.length > 0) {
      for (const cityId of selectedCitiesInRegion) appendCityParam(cityId);
      continue;
    }
    const regionItem = REGION_BY_ID.get(regionId);
    if (!regionItem?.autoRiaStateId) continue;
    const key = `${regionItem.autoRiaStateId}:0`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      regionId: regionItem.id,
      cityId: null,
      stateId: regionItem.autoRiaStateId,
      cityIdValue: 0,
      apiCityBacked: false,
    });
  }

  return result;
}

export function normalizeGeoText(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’`´]/gu, "")
    // Marketplaces sometimes append a legacy or alternate city name, for
    // example `Дніпро (Дніпропетровськ)`.  The canonical leading name is the
    // reliable lookup key; keeping the parenthetical text makes an otherwise
    // exact city fail the geo filter.
    .replace(/\([^)]*\)/gu, " ")
    // JavaScript's `\b` boundary is ASCII-oriented and does not reliably
    // recognize Ukrainian/Cyrillic words.  Use whitespace boundaries so that
    // both `Дніпропетровська область` and `Дніпропетровська` normalize to the
    // same token.
    .replace(/(^|\s)(?:область|обл|oblast|region)(?:\.|,)?(?=\s|$)/giu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function region(id: string, nameUk: string, nameRu: string, aliases: string[], cities: Omit<City, "regionId">[]): Region {
  return {
    id,
    nameUk,
    nameRu,
    aliases,
    autoRiaStateId: AUTO_RIA_STATE_ID_BY_REGION_ID[id],
    cities: cities.map((cityItem) => ({
      ...cityItem,
      regionId: id,
      autoRiaCityId: AUTO_RIA_CITY_ID_BY_CITY_ID[cityItem.id],
    })),
  };
}

function city(id: string, nameUk: string, nameRu: string, aliases: string[]): Omit<City, "regionId"> {
  return { id, nameUk, nameRu, aliases };
}

function geoTokens(id: string, nameUk: string, nameRu: string, aliases: string[]): string[] {
  return [id, nameUk, nameRu, ...aliases].map(normalizeGeoText).filter(Boolean);
}

function ukrainianSearchAliases(name: string): string[] {
  const russianKeyboardHint = name
    .replace(/І/gu, "И")
    .replace(/і/gu, "и")
    .replace(/Ї/gu, "Йи")
    .replace(/ї/gu, "йи")
    .replace(/Є/gu, "Е")
    .replace(/є/gu, "е")
    .replace(/Ґ/gu, "Г")
    .replace(/ґ/gu, "г");
  return russianKeyboardHint === name ? [] : [russianKeyboardHint];
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
