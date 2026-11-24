# ADR-0002: Tiada default model id dihantar dalam kod

**Status:** accepted at M0 · **Date:** 2026-11-24

## Masalah
LLD Appendix A tunjuk `GROQ_MODEL_PLANNING=choose_available_supported_model`.
Mudah untuk "membantu" dengan meletak default yang nampak masuk akal.

## Keputusan
`GROQ_MODEL_PLANNING` kosong secara default. Aplikasi menolak untuk jalan tanpa
ia, dan `npm run models` bertanya akaun pengguna sendiri.

## Sebab
Semakan docs rasmi pada 24 Nov 2026 mendapati `llama-3.3-70b-versatile` dan
`llama-3.1-8b-instant` — dua model yang paling biasa dicadangkan untuk free tier
Groq — kini **Enterprise (Contact Sales)**. Mana-mana default yang ditulis hari
ini berkemungkinan besar salah dalam beberapa bulan.

LLD 21 sudah menetapkan ini: "do not bake obsolete model names or quotas into
code". Default ialah nama yang ditanam, cuma dengan langkah tambahan.

## Kesan
Satu langkah setup tambahan untuk pengguna. Ditukar dengan kegagalan yang
berlaku pada masa setup dengan mesej jelas, bukan 404 di tengah mesyuarat.
