# ADR-0003: JSON Schema menghantar BENTUK sahaja; peraturan nilai kekal dalam Zod

**Status:** accepted at M0 · **Date:** 2026-11-24

## Masalah
Zod 4 `z.toJSONSchema()` menghasilkan `minLength`, `minItems`, `pattern` dan
seumpamanya. Halaman structured-outputs Groq menyenaraikan ciri yang **disokong**
(types, enum, `anyOf`, `$defs`/`$ref`) dan menyatakan dengan jelas bahawa ia
tidak menyenaraikan setiap keyword yang tidak disokong.

## Keputusan
Buang senarai keyword pengesahan sebelum menghantar schema. Semua peraturan
kuantiti kekal dalam Zod, dan dinyatakan kepada model dalam **perkataan** di
dalam prompt.

## Sebab
Keyword yang tidak didokumenkan ialah wilayah tidak diketahui: provider yang
menolak keyword tidak dikenali menggagalkan **keseluruhan** request dengan 400.
Kita tidak kehilangan apa-apa, kerana Zod ialah gate sebenar — model yang
mengabaikan arahan berbentuk perkataan tetap ditangkap oleh validasi dan
dibetulkan melalui targeted retry.

## Pelengkap wajib
Groq strict mode menuntut **setiap** property ada dalam `required`. Zod
mengeluarkan field `.optional()` daripada `required` secara senyap. Jadi
`assertGroqStrictCompatible()` berjalan ketika module dimuatkan dan melaporkan
JSON pointer yang tepat. `.optional()` **haram** dalam `src/shared/schemas.ts` —
guna `.nullable()`.

## Semak semula bila
Docs Groq menyatakan keyword ini dihormati.
