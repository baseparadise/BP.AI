# Discord Gemini AI Bot

`/cp <pertanyaan>` — bot menjawab pertanyaan apa pun menggunakan Gemini AI.

## Struktur

```
api/index.js     # Handler webhook utama: terima command /cp -> panggil Gemini -> balas
api/register.js  # Buka di browser untuk daftarkan/update command /cp
api/ping.js      # Buka di browser untuk test env vars & koneksi Gemini (debug, bukan utk Discord)
vercel.json
package.json
.env.example
```

## Environment Variables (set di Vercel dashboard)

- `APP_ID` — Discord Application ID
- `PUBLIC_KEY` — Discord Public Key
- `DISCORD_TOKEN` — Discord Bot Token
- `GEMINI_API_KEY` — API key dari [Google AI Studio](https://aistudio.google.com/apikey)
- `GEMINI_MODEL` (opsional) — default `gemini-2.0-flash`

## Langkah deploy (urutan WAJIB)

### 1. Upload semua file ini ke GitHub (replace total project lama)
Commit ke `main`, tunggu Vercel sampai status "Ready".

### 2. Cek dulu lewat `/api/ping` SEBELUM ke Discord
```
https://<project-kamu>.vercel.app/api/ping
```
Hasil sehat:
```json
{
  "env": { "APP_ID": true, "PUBLIC_KEY": true, "DISCORD_TOKEN": true, "GEMINI_API_KEY": true },
  "gemini": { "ok": true, "sampleAnswer": "Halo", "model": "gemini-2.0-flash" }
}
```
Kalau `gemini.ok` adalah `false`, baca `gemini.error` — biasanya API key salah, atau
model belum aktif untuk API key kamu. Jangan lanjut ke langkah 3 kalau ini belum `ok`.

### 3. Daftarkan/update command
```
https://<project-kamu>.vercel.app/api/register
```
Ini aman dipanggil meski command `/cp` sudah ada sebelumnya — Discord akan
menimpa definisinya dengan opsi `pertanyaan` di `api/register.js`.

### 4. Set Interactions Endpoint URL di Discord Developer Portal
```
https://<project-kamu>.vercel.app/api
```

### 5. Tes di Discord
```
/cp pertanyaan: Apa itu blockchain?
```

### 6. Kalau masih gagal
Vercel dashboard → Logs / Deployments → Functions → `api/index`. Cari baris dengan
prefix `[index]` atau `[handleCpCommand]` di waktu kamu tes.

## Kustomisasi
- Ganti kepribadian/bahasa jawaban AI: edit `SYSTEM_PROMPT` di `api/index.js`.
- Ganti model Gemini: set env var `GEMINI_MODEL` (contoh: `gemini-1.5-pro`, `gemini-2.0-flash`).
