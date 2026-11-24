# ADR-0005: Program tidak mengisi skor rubrik

**Status:** accepted at M0 · **Date:** 2026-11-24

## Masalah
LLD 14.2 menetapkan rubrik 8 metrik × 0-2 mata dan gate "sekurang-kurangnya
13/16 pada dua daripada tiga brief". Menggodanya untuk mengira ini automatik.

## Keputusan
Laporan mengira **signal yang boleh disemak mesin** (objection yang merujuk
proposal yang benar-benar ada, ADR yang lulus peraturan dua-alternatif, berapa
requirement dirujuk oleh ADR, frasa generik yang dikesan dalam output Security)
dan meninggalkan lajur skor **kosong**.

## Sebab
Perbezaan antara "generic critique" (1 mata) dan "specific, evidence-based
objection" (2 mata) ialah penghakiman. Program yang menganggarkannya akan salah,
dan apabila ia salah ia salah ke arah **melepaskan** — kerana output yang fasih
nampak seperti output yang baik.

LLD 14.2 sendiri berkata "Review manually with actual transcripts". HLD prinsip 3
berkata "Evidence over theatre". Rubrik yang diisi sendiri ialah teater.

## Kesan
Lulus P0 memerlukan seseorang membaca tiga transkrip. Itu kos yang betul untuk
gate yang menentukan sama ada coding automatik dibenarkan.
