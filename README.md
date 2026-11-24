# DevOffice AI — M0 (Technical Spike)

**Status: M0 siap untuk semakan. Menunggu approval Product Owner sebelum M1.**

Repo ini ialah **milestone M0** daripada DevOffice AI Master Blueprint v1.0
(`DevOffice_AI_HLD_v1.0` + `DevOffice_AI_LLD_v1.0`).

---

## 1. Apa itu M0, dalam satu ayat

M0 membuktikan **satu perkara sahaja**: bahawa beberapa AI agent boleh diberi
peranan berbeza, dipaksa mengeluarkan jawapan berstruktur yang sah, mencabar
kerja satu sama lain, dan semuanya direkod dengan jujur — walaupun bila kuota
API habis di tengah jalan.

**M0 bukan**:

| Bukan | Sebab |
|---|---|
| Website / dashboard | UI bermula M1 |
| Penjana spesifikasi penuh | Spec generation ialah M3 |
| Penjana code | Coding ialah M4/M5, selepas approval berasingan |
| Bukti kualiti AI | Itu perlu key sebenar — lihat Bahagian 6 |

Tiada shell execution, tiada sandbox, tiada deploy. Ada ujian automatik yang
mengimbas source code dan **gagal** jika sesiapa menambah `child_process`,
`eval()`, atau apa-apa yang boleh melaksanakan arahan.

---

## 2. Cara jalankan (5 minit, tanpa API key)

Perlu **Node.js 20.11 atau lebih baru**. Semak dengan `node -v`.

```bash
npm install
npm run typecheck     # sepatutnya 0 ralat
npm test              # sepatutnya 101 ujian lulus
npm run check:env     # beritahu anda apa yang sudah/belum sedia
npm run bench:mock    # jalankan mesyuarat 3 pusingan penuh, tanpa API key
```

`npm run bench:mock` guna **template provider**, bukan model AI. Setiap baris
output bertanda `[SIMULATED]`. Ia membuktikan *wiring* berfungsi — schema,
event log, nombor urutan, throttle, peralihan state — dan **tidak** memberitahu
apa-apa tentang kualiti perbincangan agent. Laporan yang dihasilkan menolak
dirinya sendiri untuk skor rubrik.

---

## 3. Cara jalankan dengan Groq sebenar

```bash
cp .env.example .env
```

1. Dapatkan key di <https://console.groq.com/keys>, letak dalam `.env` sebagai
   `GROQ_API_KEY`.
2. Jalankan `npm run models`. Ini **tanya akaun anda sendiri** model apa yang
   boleh dicapai.
3. Salin satu id dari senarai itu ke `GROQ_MODEL_PLANNING` dalam `.env`.
4. `npm run check:env` — sepatutnya kata `OK`.
5. `npm run bench -- --brief=b1-portfolio`

### Kenapa `GROQ_MODEL_PLANNING` kosong secara default?

Sengaja. Pada **24 Nov 2026**, menurut docs rasmi Groq:

| Model | Status |
|---|---|
| `openai/gpt-oss-120b` | Self-serve, sokong strict JSON schema |
| `openai/gpt-oss-20b` | Self-serve, sokong strict JSON schema |
| `qwen/qwen3.8-27b` | Self-serve, sokong strict JSON schema |
| `llama-3.3-70b-versatile` | **Enterprise sahaja (Contact Sales)** |
| `llama-3.1-8b-instant` | **Enterprise sahaja (Contact Sales)** |

Model Llama yang dulu popular untuk free tier **sudah tidak boleh dicapai**
secara self-serve. Jika kod ini menulis mana-mana nama model sebagai default, ia
akan rosak apabila senarai berubah lagi. Jadi anda sahkan dahulu, baru set.

---

## 4. Arahan lain

| Arahan | Apa ia buat |
|---|---|
| `npm run bench -- --brief=all` | Jalankan ketiga-tiga benchmark brief |
| `npm run bench -- --brief=b2-event-landing` | Satu brief sahaja |
| `npm run bench -- --brief=b1-portfolio --run-id=xyz` | **Sambung** run yang terhenti |
| `npm run test:watch` | Ujian berjalan sambil anda edit |

Setiap run menulis dua fail dalam `runs/<run-id>/`:

- `events.jsonl` — setiap kejadian, satu JSON satu baris, bernombor urutan
- `usage.jsonl` — satu baris per panggilan model: token, latency, retry, ralat

Laporan bukti ditulis ke `docs/evidence/`.

---

## 5. Struktur kod

```
src/
  shared/       schema Zod, kod ralat, config, event log      <- tiada AI di sini
  providers/    interface ModelProvider + Groq + mock          <- satu-satunya tempat "Groq" disebut
  agents/       definisi peranan, prompt, kontrak per-pusingan
  workflows/    orchestrator mesyuarat, build gate
  benchmarks/   3 brief + penjana laporan
  cli/          check:env, models, bench
tests/          101 ujian
```

Peraturan yang dikuatkuasakan oleh ujian: **tiada fail di luar `src/providers/`
dan `src/cli/` dibenarkan menyebut nama model**. Itulah maksud
"provider-agnostic" — tukar Groq ke provider lain hanya menyentuh satu folder.

---

## 6. Apa yang SUDAH dan BELUM terbukti

Ini bahagian paling penting dalam README ini. Jangan percaya apa-apa yang tidak
tersenarai di sebelah kiri.

### Sudah terbukti (101 ujian automatik, `npm test`)

- Kelima-lima schema lulus peraturan strict mode Groq (semua field `required`,
  `additionalProperties: false`)
- `"I agree"` sahaja **ditolak** sebagai sumbangan
- Objection tanpa rujukan proposal sebenar, tanpa bukti, atau tanpa cadangan
  pembetulan — **ditolak**
- ADR dengan satu alternatif sahaja, atau yang memilih sesuatu yang tak
  disenaraikan — **ditolak**
- 429 dengan `retry-after` → tunggu tepat sebanyak itu, cuba lagi, berjaya
- 429 tanpa `retry-after` → exponential backoff dengan jitter, ada had
- 429 kuota harian → `QUOTA_EXHAUSTED`, **tidak** cuba lagi, progress disimpan
- 401 → berhenti serta-merta, tiada retry
- JSON rosak → provider beritahu model field mana yang salah, cuba lagi
- Worker dibunuh di tengah mesyuarat → sambung dari checkpoint, **tiada event
  berganda**, sumbangan lama **tidak dibeli semula**
- Throttle menghormati had token *dan* had request
- Permintaan build → `BUILD_NOT_ENABLED`, direkod dalam audit log
- Brief bermuatan "ignore all instructions" → fence tidak boleh dipecahkan,
  tiada tool diberi, mesyuarat tamat normal
- API key tidak pernah muncul dalam log atau mesej ralat

### BELUM terbukti — perlukan API key sebenar

- Bahawa Groq menerima `response_format` kita (termasuk sama ada field itu
  `max_completion_tokens` atau `max_tokens` — docs tidak nyatakan)
- Bahawa agent sebenarnya memberi kritikan pakar yang bermakna, bukan sekadar
  teks yang kedengaran bagus
- Had kuota sebenar akaun anda
- **Skor rubrik LLD 14.2** — ini mesti dinilai manusia, dari transkrip sebenar

Program ini **tidak akan** mengisi skor rubrik sendiri. Mengisinya secara
automatik bermakna gate penerimaan jadi hiasan sahaja — iaitu kegagalan
"evidence over theatre" yang HLD memang amarkan.

---

## 7. Seterusnya

Baca `docs/M0-REPORT.md`. Ia mengandungi:

- 13 penemuan (percanggahan, risiko, andaian) dalam blueprint, dengan cadangan
- peta pelaksanaan M0–M5
- ujian penerimaan M0 dan buktinya

M1 **tidak** akan dimulakan sebelum Product Owner approve.
