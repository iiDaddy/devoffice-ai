# ADR-0006: Validator berbeza per pusingan, dengan senarai id yang sah

**Status:** accepted at M0 · **Date:** 2026-11-24

## Masalah
Dijumpai semasa menjalankan harness, bukan semasa membaca blueprint.

`AgentContributionV1` membenarkan `contribution_type: "proposal"` dengan
`related_proposal_id: null`. Itu **betul** untuk pusingan 1 dan **salah** untuk
pusingan 2, di mana tujuan keseluruhannya ialah bertindak terhadap kerja orang
lain.

Akibatnya: satu turn pusingan 2 memulangkan proposal baharu, lulus validasi, dan
mesyuarat merekod cross-review = 0 sambil kelihatan **lengkap**. Mesyuarat tanpa
cross-review, yang laporannya kata siap.

Lebih teruk: LLD 6.2 menuntut objection merujuk `related_proposal_id` yang
**benar-benar ada**. "Benar-benar ada" tidak boleh disemak oleh schema statik —
ia bergantung pada proposal mana yang wujud dalam mesyuarat itu.

## Keputusan
`src/agents/contribution-contracts.ts` menyediakan:

- `PROPOSAL_CONTRACT` — pusingan 1, mesti `proposal`
- `reactionContract(knownProposalIds)` — pusingan 2, mesti bukan `proposal`, dan
  id yang dirujuk mesti ada dalam senarai yang dibina daripada mesyuarat semasa

Kedua-duanya menghantar **JSON Schema yang sama** ke wire; hanya gate Zod
berbeza.

## Sebab reka bentuk ini
Pelanggaran ditangkap oleh repair loop provider yang **sudah ada**: model
diberitahu dengan tepat apa yang salah, termasuk senarai id yang sah, dan
diminta semula. Tiada laluan ralat baharu, tiada penerimaan senyap.
