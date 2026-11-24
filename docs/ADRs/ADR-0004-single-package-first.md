# ADR-0004: Satu package dahulu, monorepo bila ada yang kedua

**Status:** accepted at M0 · **Date:** 2026-11-24

## Masalah
LLD 1.2 mencadangkan monorepo `apps/web`, `apps/worker`, `packages/*`. LLD juga
menyatakan prinsip YAGNI dan benarkan mula dengan package minimum.

## Keputusan
Satu package. Folder dalam `src/` dinamakan **sama** dengan package masa depan:
`shared/`, `providers/`, `agents/`, `workflows/`, `benchmarks/`, `cli/`.

## Sebab
M0 tiada web app dan tiada worker process berasingan — jadi tiada apa yang perlu
dipisahkan oleh workspace boundary. npm workspaces + TypeScript project
references menambah ralat build yang mengelirukan tanpa memberi apa-apa hari ini.

Sempadan yang penting dikuatkuasakan oleh **ujian**, bukan oleh struktur folder:
`tests/security.test.ts` gagal jika mana-mana fail di luar `src/providers/` atau
`src/cli/` menyebut nama model.

## Bila ditukar
M1, bila `apps/web` wujud. Nama folder sudah sepadan, jadi ia pemindahan fail,
bukan penulisan semula.
