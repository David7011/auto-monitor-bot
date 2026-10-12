# Future OCR / ALPR Worker

Placeholder для будущего worker на Python.

Задача будущего модуля:

1. Скачать фото объявления.
2. Найти номерной знак через ALPR.
3. Найти VIN через OCR.
4. Нормализовать номер/VIN.
5. Передать результат в Vehicle Check Module.

Планируемые инструменты:

- FastALPR / OpenALPR-подход для номерных знаков;
- PaddleOCR / Tesseract для VIN и текста;
- OpenCV для preprocessing.

В MVP используется fake background check: он имитирует будущую проверку и проверяет pipeline `sendMessage -> editMessageText`.
