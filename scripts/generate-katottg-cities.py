from __future__ import annotations

import argparse
from pathlib import Path

import openpyxl


REGION_ID_BY_OFFICIAL_NAME = {
    "Автономна Республіка Крим": "crimea",
    "Вінницька": "vinnytska",
    "Волинська": "volynska",
    "Дніпропетровська": "dnipropetrovska",
    "Донецька": "donetska",
    "Житомирська": "zhytomyrska",
    "Закарпатська": "zakarpatska",
    "Запорізька": "zaporizka",
    "Івано-Франківська": "ivano-frankivska",
    "Київська": "kyivska",
    "Кіровоградська": "kirovohradska",
    "Луганська": "luhanska",
    "Львівська": "lvivska",
    "Миколаївська": "mykolaivska",
    "Одеська": "odeska",
    "Полтавська": "poltavska",
    "Рівненська": "rivnenska",
    "Сумська": "sumska",
    "Тернопільська": "ternopilska",
    "Харківська": "kharkivska",
    "Херсонська": "khersonska",
    "Хмельницька": "khmelnytska",
    "Черкаська": "cherkaska",
    "Чернівецька": "chernivetska",
    "Чернігівська": "chernihivska",
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate the bundled Ukraine city list from an official KATOTTG workbook.")
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()

    print(f"Reading {args.source}", flush=True)
    workbook = openpyxl.load_workbook(args.source, read_only=True, data_only=True)
    sheet = workbook.active
    region_code_to_id: dict[str, str] = {}
    entries: list[tuple[str, str, str]] = []
    pending_cities: list[tuple[str, str, str]] = []

    for row in sheet.iter_rows(min_row=5, max_col=7, values_only=True):
        code, category, raw_name = row[3], row[5], row[6]
        name = str(raw_name).strip() if raw_name else ""
        if category == "O" and row[0] and name in REGION_ID_BY_OFFICIAL_NAME:
            region_code_to_id[str(row[0])] = REGION_ID_BY_OFFICIAL_NAME[name]
        if category != "M" or not code or not raw_name:
            continue
        region_id = region_code_to_id.get(row[0])
        if region_id:
            entries.append((str(code).lower(), region_id, name))
        else:
            pending_cities.append((str(code).lower(), str(row[0]), name))

    for code, region_code, name in pending_cities:
        region_id = region_code_to_id.get(region_code)
        if region_id:
            entries.append((code, region_id, name))

    entries.extend(
        [
            ("ua80000000000093317", "kyiv-city", "Київ"),
            ("ua85000000000065278", "crimea", "Севастополь"),
        ]
    )
    entries.sort(key=lambda item: (item[1], item[2].casefold()))

    lines = [
        f"// Generated from the official KATOTTG codifier dated {args.version}.",
        "// Source: https://mindev.gov.ua/diialnist/rozvytok-mistsevoho-samovriaduvannia/kodyfikator-administratyvno-terytorialnykh-odynyts-ta-terytorii-terytorialnykh-hromad",
        "// Do not edit individual rows manually.",
        "",
        f'export const UKRAINE_CITIES_DATA_VERSION = "KATOTTG-{args.version}";',
        "",
        "export const GENERATED_UKRAINE_CITIES = [",
    ]
    for code, region_id, name in entries:
        escaped_name = name.replace("\\", "\\\\").replace('"', '\\"')
        lines.append(f'  ["katottg-{code}", "{region_id}", "{escaped_name}"],')
    lines.extend(
        [
            "] as const;",
            "",
            "export type GeneratedUkraineCity = (typeof GENERATED_UKRAINE_CITIES)[number];",
            "",
        ]
    )

    if len(entries) < 450:
        raise RuntimeError(f"KATOTTG city count is unexpectedly low: {len(entries)}")

    args.target.parent.mkdir(parents=True, exist_ok=True)
    args.target.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    print(f"Generated {len(entries)} cities in {args.target}")


if __name__ == "__main__":
    main()
