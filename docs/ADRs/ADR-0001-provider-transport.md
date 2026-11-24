# ADR-0001: Plain `fetch` for the Groq adapter, not the vendor SDK

**Status:** accepted at M0 · **Date:** 2026-11-24

## Masalah
LLD 4.2 benarkan dua pilihan: "supported Groq TypeScript SDK or its
OpenAI-compatible API".

## Keputusan
Guna `fetch` terhadap `https://api.groq.com/openai/v1`, dengan `fetchImpl` yang
boleh disuntik (injectable).

## Sebab
Yang menentukan ialah **kebolehujian**. Kerja paling berisiko dalam M0 ialah
pengendalian 429, pembezaan kuota harian, dan pemulihan selepas worker mati.
Dengan `fetchImpl` yang disuntik, semua laluan itu diuji tanpa network dan tanpa
API key — 27 ujian dalam `tests/resilience.test.ts` berjalan dalam 0.4 detik.
Kalau guna SDK, kita perlu mock dalaman SDK, yang bermakna kita menguji mock kita
sendiri, bukan tingkah laku sebenar.

Kesan sampingan: satu dependency kurang.

## Kos
Kita tanggung sendiri padanan dengan OpenAI wire format. Dikurangkan dengan
ujian `request shape` yang menyemak kita tidak menghantar field yang Groq
dokumenkan sebagai tidak disokong (`logprobs`, `logit_bias`, `top_logprobs`,
`n`, `messages[].name`).
