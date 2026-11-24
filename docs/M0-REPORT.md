# DevOffice AI — Laporan M0

**Tarikh:** 24 November 2026 · **Status:** M0 siap, menunggu approval Product Owner

---

## Bahagian A — 13 penemuan dalam blueprint

LLD 0 menetapkan: jika HLD dan LLD bercanggah, flag dan cadangkan resolusi,
jangan ubah skop senyap-senyap. Berikut semua yang dijumpai. **Enam** sudah
diselesaikan dalam kod M0; **tujuh** memerlukan keputusan anda.

### A1. Model Groq yang dirujuk sudah tidak boleh dicapai secara self-serve
**Jenis:** percanggahan fakta · **Status:** diselesaikan dalam kod

HLD 10 dan Appendix B merancang sekitar "Groq Free". Semakan docs rasmi pada
24 Nov 2026 mendapati:

| Model | Status hari ini |
|---|---|
| `llama-3.3-70b-versatile` | Enterprise (Contact Sales) |
| `llama-3.1-8b-instant` | Enterprise (Contact Sales) |
| `openai/gpt-oss-120b` | Self-serve, strict JSON schema |
| `openai/gpt-oss-20b` | Self-serve, strict JSON schema |
| `qwen/qwen3.8-27b` | Self-serve, strict JSON schema |

**Cadangan:** tiada default model dalam kod; `npm run models` bertanya akaun anda
(ADR-0002). **Tindakan anda:** jalankan `npm run models` dan beritahu saya id
mana yang muncul.

### A2. "Groq Free API" mungkin bukan produk yang berasingan
**Jenis:** andaian tidak disahkan · **Status:** perlu keputusan anda

Halaman rate-limits Groq tidak memisahkan nombor free tier dengan jelas. Jadual
berkepala "Free Plan Limits / Developer Plan Limits" tanpa lajur berasingan, dan
satu nota menyatakan angka yang ditunjuk ialah had asas pelan Developer.

**Risiko:** jika akaun anda sebenarnya pay-as-you-go, menjalankan tiga benchmark
brief akan **menanggung kos sebenar**, bukan menggunakan kuota percuma.

**Cadangan:** buka halaman limits dalam settings akaun Groq anda dan sahkan
sebelum run pertama. Jangan percaya angka dalam docs atau dalam README ini.

### A3. Had token-per-minit, bukan had request, yang akan mengikat
**Jenis:** risiko reka bentuk · **Status:** diselesaikan dalam kod

Docs menunjukkan `openai/gpt-oss-120b` pada pelan Developer asas: **30 request/
minit tetapi hanya 8,000 token/minit**. Satu panggilan planning dengan brief dan
system prompt ialah ~2,000–3,000 token. Jadi had sebenar lebih kurang **tiga
panggilan seminit**, bukan tiga puluh.

LLD 4.3 menyebut "request pacing" dan "configurable concurrency" — kedua-duanya
berorientasi request. Limiter berasaskan request sahaja akan melepasi had
sebenar tiga kali ganda dan mengumpul 429.

**Cadangan:** throttle sedar-token dibina (`src/providers/throttle.ts`), dengan
header provider mengatasi tekaan kita. **Kesan yang anda perlu terima:** satu
mesyuarat 6 agen × 3 pusingan ≈ 14 panggilan ≈ **5–8 minit masa dinding**, bukan
beberapa detik.

### A4. Structured output tidak boleh di-stream
**Jenis:** percanggahan dengan UX · **Status:** perlu keputusan anda

Docs structured-outputs menyatakan terus: streaming dan tool use **tidak**
disokong bersama Structured Outputs.

HLD 6.1 "Watch Live" boleh dibaca dua cara. Jika maksudnya teks menaip masuk
seperti chat — **itu tidak mungkin** dengan strict JSON. Jika maksudnya event
dihantar bila setiap sumbangan selesai — itu berfungsi, dan itulah yang LLD 15.4
sudah terangkan.

**Cadangan:** tetapkan "Watch Live" bermaksud **event-level**: satu event bila
satu agen selesai. Satu baris muncul setiap ~30 detik. Sahkan ini supaya tiada
siapa membina UI streaming token di M1.

### A5. LLD 6.2 ada peraturan yang payload-nya tidak boleh menyatakan
**Jenis:** jurang kontrak · **Status:** diselesaikan, **tapi ini perubahan
kontrak — perlu persetujuan anda**

LLD 6.2 menetapkan objection mesti "describe a reason **and recommend a change or
mitigation**". Tetapi contoh payload `AgentContributionV1` tiada field untuk
membawa cadangan itu. Peraturan itu tidak boleh dikuatkuasakan mesin.

**Ditambah kepada kontrak:**
- `recommended_change: string | null` — wajib untuk objection dan revision
- `evidence: string[]` — wajib tidak-kosong untuk objection

**Tindakan anda:** luluskan dua field ini, atau beritahu saya untuk
menguatkuasakan peraturan itu dengan cara lain.

### A6. Kontrak tidak boleh membezakan pusingan 1 dan pusingan 2
**Jenis:** pepijat, dijumpai semasa menjalankan harness · **Status:** diselesaikan

`AgentContributionV1` membenarkan `contribution_type: "proposal"` dengan
`related_proposal_id: null`. Betul untuk pusingan 1. Untuk pusingan 2 ia
bermakna agen menghantar proposal baharu dan **tiada cross-review berlaku** —
sambil mesyuarat kelihatan lengkap dan laporan kata siap.

**Cadangan:** validator per-pusingan, dan id yang dirujuk disemak terhadap
proposal yang benar-benar wujud dalam mesyuarat itu (ADR-0006). Pelanggaran
dibetulkan oleh repair loop yang sudah ada.

### A7. `max_calls_per_meeting: 2` bercanggah dengan pusingan 3 LLD 7
**Jenis:** percanggahan · **Status:** perlu keputusan anda

LLD 5 menetapkan `max_calls_per_meeting: 2`. LLD 7 pusingan 3 menetapkan tiga
perkara: Tech Lead jana keputusan, **PM semak traceability**, **QA semak sama ada
kriteria boleh diuji**.

Untuk QA itu bermakna tiga panggilan (pusingan 1, 2, 3) — melebihi had 2.

**M0 melaksanakan:** pusingan 3 = sintesis Tech Lead sahaja. Semakan PM dan QA
belum ada.

**Pilihan anda:**
1. Naikkan `max_calls_per_meeting` kepada 3 untuk PM dan QA — +2 panggilan
   semesyuarat, lebih banyak token
2. Buat semakan traceability secara **deterministik dalam kod** (kami sudah
   mengiranya sebagai signal — lihat `requirementTraceability`) — kos sifar
3. Kekalkan M0 seperti sekarang dan putuskan di M2

**Saya cadangkan pilihan 2** untuk traceability, kerana ia aritmetik, bukan
penghakiman. Semakan "boleh diuji" oleh QA memang perlukan model.

### A8. Docs tidak menyatakan `max_tokens` atau `max_completion_tokens`
**Jenis:** dependency tidak diketahui · **Status:** diselesaikan dengan cara yang
boleh dikonfigur

Halaman OpenAI-compatibility Groq menyenaraikan field yang tidak disokong
(`logprobs`, `logit_bias`, `top_logprobs`, `messages[].name`, `n` ≠ 1) tetapi
**tidak menyebut** yang mana satu digunakan untuk had output.

**Cadangan:** default mengikut istilah jadual model Groq
(`max_completion_tokens`), boleh ditukar. **Ini antara perkara pertama yang akan
gagal pada panggilan sebenar pertama**, dan ia gagal dengan 400 yang jelas.

### A9. Temperature 0 ditulis semula oleh provider
**Jenis:** risiko kebolehulangan · **Status:** diselesaikan separa

Docs: temperature 0 ditukar kepada 1e-8. Untuk skor rubrik yang boleh diulang
kita mahu 0.

**Kesan:** run benchmark **tidak** boleh diulang secara bit-exact. Skor rubrik
patut berdasarkan lebih daripada satu run per brief, atau diterima sebagai
anggaran. Default kami 0.3.

### A10. Tiada auth di M0, tetapi LLD 2.2 menuntutnya untuk approval
**Jenis:** risiko keselamatan · **Status:** dielak dengan skop

LLD 2.2: "Only authenticated owner can approve". M0 tiada auth dan tiada
Supabase.

**Cadangan:** M0 tiada approval sama sekali — tiada apa untuk diluluskan sebelum
spec wujud di M3. **Peraturan yang perlu dipegang:** jangan tambah
mana-mana endpoint approval sebelum auth wujud di M1. Sekali endpoint approval
ada tanpa auth, gate itu hiasan.

### A11. Pertahanan prompt-injection tidak boleh bergantung pada prompt
**Jenis:** risiko keselamatan · **Status:** diselesaikan secara berlapis

LLD 16 menyatakan "strictly separate instructions from untrusted project briefs".
Itu perlu, tetapi perkataan dalam prompt **bukan** sempadan keselamatan — model
boleh diyakinkan.

**Sempadan sebenar yang dibina:**
1. Setiap peranan planning ada `allowed_tools: []`, dan **tiada kod membacanya
   untuk memberi apa-apa**
2. Kontrak output ialah enum tertutup — tiada field yang boleh menyatakan
   "jalankan arahan ini" atau "luluskan spec ini"
3. Tiada `child_process`, tiada `eval`, tiada `vm` dalam seluruh source — diuji
   oleh scan automatik yang **gagal** build jika ditambah
4. Fence data pengguna, dengan marker palsu dineutralkan

Lapisan 1–3 bertahan walaupun model sepenuhnya diperdaya. Itulah sebabnya ia
diutamakan berbanding perkataan prompt.

### A12. Kuota harian cukup untuk 3 brief, tanpa banyak ruang
**Jenis:** risiko operasi · **Status:** dielak dengan resume

Jika angka docs terpakai (200K token/hari untuk gpt-oss-120b): tiga brief ×
~14 panggilan × ~2.5K token ≈ **105K token**. Muat dalam sehari, tetapi retry,
repair schema dan run kedua untuk kebolehulangan akan menghabiskannya cepat.

**Cadangan:** jalankan **satu brief sehari**. Jika kuota habis di tengah,
run jadi `BLOCKED` dengan progress utuh dan boleh disambung — diuji (T13, T14).

### A13. Persistence M0 ialah fail, bukan Postgres
**Jenis:** dependency tertunda · **Status:** hutang teknikal yang diniatkan

LLD 8 menuntut Postgres dengan RLS. M0 menulis JSONL ke `runs/<run-id>/`.

**Mitigasi:** API `EventLog` sengaja dibentuk sama dengan jadual yang akan
datang — sequence monotonik per run, unique `(run_id, sequence_number)`,
idempotency key, `readAfter(n)` untuk reconnect. M1 menukar implementasi, bukan
pemanggil.

---

## Bahagian B — Peta pelaksanaan M0–M5

```
M0  Technical spike                                    << SIAP, menunggu approval
    Groq adapter, schema Zod, 3 brief, event log, throttle, ujian 429
    Bergantung pada: tiada
    Lulus bila: 101 ujian lulus + 3 brief dijalankan dengan key sebenar
                + rubrik diisi manusia

M1  Product foundation
    Next.js, Supabase Auth + migrations + RLS, CRUD projek, event viewer,
    Office View dipacu mock, ujian state machine
    Bergantung pada: M0 diluluskan; akaun Supabase
    Risiko: nama key Supabase berubah antara versi SDK — sahaja ketika setup
    Lulus bila: dua user berbeza tidak boleh melihat projek masing-masing (T16)

M2  Multi-agent planning engine
    Worker process sebenar (berasingan dari web request), roster, 3 pusingan,
    ADR sebenar, Hybrid Meeting live/summary
    Bergantung pada: M1 (DB + auth); M0 provider adapter diguna semula
    Pindahkan ke sini: semakan QA "boleh diuji" di pusingan 3 (lihat A7)
    Lulus bila: bunuh worker di tengah mesyuarat, UI pulih tanpa event berganda

M3  Spec + approval gate
    FinalSpecV1, render Markdown, diff versi, approval owner, spec immutable,
    BUILD_NOT_ENABLED dipaparkan dengan jujur
    Bergantung pada: M2
    Lulus bila: klik approve dua kali menghasilkan satu kesan sahaja (T11)

    >>> DI SINI P0 PLANNING LAB LENGKAP. NILAI KUALITI SEBELUM TERUSKAN. <<<

M4  Coding engine + sandbox
    Pilih runner (OpenCode salah satu calon), adapter CodingEngine, sandbox,
    task dependency, tulis fail sebenar, checkpoint Git
    Bergantung pada: M3 diluluskan + sandbox disahkan + bajet diputuskan
    Risiko: container Docker asas sahaja TIDAK memadai untuk code tidak dipercayai
    Lulus bila: code berjalan hanya dalam sandbox, tiada akses home/secret

M5  QA, repair, preview
    Gate build/test/security, repair berhad (maks 2 kitaran), storan artifact,
    local preview, ujian pemulihan restart
    Bergantung pada: M4
    Lulus bila: satu brief portfolio menghasilkan website sebenar yang build
                lulus, ATAU blocker dilaporkan dengan jujur
```

**Laluan kritikal:** M0 → M1 → M2 → M3. M4 tidak boleh bermula sebelum M3
diluluskan — itu bukan sekadar urutan, ia gate dalam HLD 12.

---

## Bahagian C — Seni bina seperti yang dibina di M0

```
                        ┌─────────────────────────────┐
   npm run bench ──────>│  src/cli/run-benchmark.ts   │
                        └──────────────┬──────────────┘
                                       │
                        ┌──────────────▼──────────────┐
                        │  src/workflows/meeting.ts   │  DETERMINISTIK
                        │  • siapa bercakap, bila     │  (bukan AI employee)
                        │  • siapa nampak apa         │
                        │  • checkpoint + resume      │
                        └───┬───────────────┬─────────┘
                            │               │
            ┌───────────────▼──┐     ┌──────▼─────────────────┐
            │ agents/          │     │ shared/events.ts       │
            │ • roles.ts       │     │ runs/<id>/events.jsonl │
            │ • prompts.ts     │     │ runs/<id>/usage.jsonl  │
            │ • contribution-  │     │ sequence + idempotency │
            │   contracts.ts   │     └────────────────────────┘
            └───────────────┬──┘
                            │  ModelRequest / ModelResponse
            ┌───────────────▼────────────────────────────┐
            │  providers/types.ts  (interface sahaja)    │
            └───┬─────────────────────────────┬──────────┘
                │                             │
     ┌──────────▼─────────┐        ┌──────────▼──────────┐
     │ providers/groq.ts  │        │ providers/mock.ts   │
     │ + throttle.ts      │        │ simulated = true    │
     │ + retry.ts         │        └─────────────────────┘
     └──────────┬─────────┘
                │  HTTPS, fetch boleh disuntik
     ┌──────────▼───────────────────────┐
     │ api.groq.com/openai/v1           │
     └──────────────────────────────────┘

     ┌──────────────────────────────────────────────────┐
     │ workflows/build-gate.ts                          │
     │ requestBuild() SELALU tolak: BUILD_NOT_ENABLED   │
     │ Tiada shell. Tiada sandbox. Tiada deploy.        │
     └──────────────────────────────────────────────────┘
```

Hanya `providers/` dan `cli/` dibenarkan menyebut nama model. Dikuatkuasakan
oleh ujian.

---

## Bahagian D — Schema yang dilaksanakan

| Schema | Field | Peraturan utama dikuatkuasakan |
|---|---|---|
| `ProjectBriefV1` | 7 | Input owner; bukan output model |
| `RequirementSetV1` | 7 | Setiap requirement ada id, boleh diuji, bertanda must/should/could/wont, dan `source` menandakan jika PM mengisi jurang |
| `AgentContributionV1` | 13 | Cross-review LLD 6.2: objection mesti rujuk proposal nyata + bukti + cadangan pembetulan; `"I agree"` ditolak |
| `ArchitectureDecisionV1` | 8 | Minimum dua alternatif; setiap satu ada pro DAN kon; `selected` mesti salah satu yang disenaraikan |
| `TechLeadSynthesisV1` | 4 | Merekod apa yang **berubah** kerana maklum balas pusingan 2; blocker ditanda blocking atau tidak |

Kelima-limanya lulus guard strict mode Groq. `.optional()` haram — guna
`.nullable()` (ADR-0003).

---

## Bahagian E — Ujian penerimaan M0 dan buktinya

Jalankan `npm run typecheck && npm test`.

```
tsc --noEmit                    0 ralat
vitest run                      101 lulus / 101, 6 fail, 1.32s
```

| Fail | Ujian | Apa yang dibuktikan |
|---|---|---|
| `contracts.test.ts` | 23 | Guard strict mode; peraturan cross-review LLD 6.2; validasi ADR |
| `resilience.test.ts` | 27 | 429 + retry-after; backoff + jitter; kuota harian; 401; 500; repair schema; bentuk request; key tidak pernah bocor |
| `throttle.test.ts` | 11 | Had token DAN request; concurrency 1; keadilan FIFO; header provider mengatasi |
| `durability.test.ts` | 10 | Sequence monotonik; idempotency; pulih selepas baris separa-tulis; `readAfter` untuk reconnect |
| `orchestration.test.ts` | 13 | Roster T02; 3 pusingan; NEEDS_INPUT T07; kuota habis T13; **resume T14** |
| `security.test.ts` | 18 | Build gate T12; prompt injection T17; scan tiada-exec; pengendalian secret |

### Peta ke pelan ujian LLD 19

| ID | Ujian | Status M0 |
|---|---|---|
| T02 | Pemilihan agen | **Lulus** — portfolio tiada backend; payment ada |
| T03 | Pusingan 1 | **Lulus** (bentuk sahaja; kualiti perlu key) |
| T04 | Pusingan 2 rujuk proposal nyata | **Lulus** |
| T05 | Pusingan 3 ADR | **Lulus** (bentuk) |
| T07 | Soalan blocker → NEEDS_INPUT | **Lulus** |
| T11 | Approve dua kali | **Separa** — idempotency event diuji; approval ialah M3 |
| T12 | Cubaan coding di P0 ditolak | **Lulus** |
| T13 | Kuota dipaksa habis | **Lulus** |
| T14 | Bunuh worker di tengah mesyuarat | **Lulus** |
| T15 | Reconnect UI | **Separa** — `readAfter` diuji; UI ialah M1 |
| T01, T06, T08–T10, T16 | — | M1–M3 |
| T17 | Suntik "ignore instructions" | **Lulus** (mekanikal — lihat A11) |
| T18–T20 | — | M4–M5 |

### Apa yang BELUM dibuktikan

Tiada `GROQ_API_KEY` dalam persekitaran ini, jadi **tiada panggilan API sebenar
pernah dibuat**. Secara khusus belum disahkan:

1. Groq menerima envelope `response_format` kita
2. `max_completion_tokens` ialah nama field yang betul (A8)
3. Nullable sebagai `anyOf` diterima oleh strict mode (docs tunjuk `["string","null"]`)
4. Had kuota sebenar akaun anda
5. **Sama ada agent memberi kritikan pakar yang bermakna** — ini keseluruhan
   tujuan M0 dan ia memerlukan key

Run `bench:mock` dalam `docs/evidence/` menggunakan template provider. Setiap
laporan mengandungi amaran yang menolak dirinya sendiri untuk skor rubrik.

---

## Bahagian F — Yang saya perlukan daripada anda

1. **Luluskan atau tolak** dua field tambahan dalam `AgentContributionV1` (A5)
2. **Putuskan** A7: semakan traceability PM/QA — naikkan had panggilan, buat
   secara deterministik, atau tunda ke M2
3. **Sahkan** A4: "Watch Live" bermaksud event-level, bukan streaming token
4. **Jalankan** `npm run models` dan beritahu saya id yang muncul
5. **Sahkan** halaman limits akaun Groq anda sebelum run pertama (A2) — supaya
   tiada kos yang tidak dijangka
6. **Approve M1** hanya selepas anda menjalankan tiga brief dengan key sebenar
   dan mengisi rubrik sendiri

Saya **tidak** akan memulakan M1 sebelum anda kata ya.
