window.CHRONIK_CONFIG = {

  /* --- 1. Supabase: Konten, Ereignisse, Kommentare -------- */
  url: "https://mhdjmuyfccyfeoffplbk.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1oZGptdXlmY2N5ZmVvZmZwbGJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2Nzc5NDIsImV4cCI6MjEwMzI1Mzk0Mn0.bIIEMuwjjRglIa74A-4xVUixiVKKdJiYzb2p1SH9FAE",

  /* --- 2. Cloudflare R2: die Bilder ---------------------- */
  r2Worker: "chronik-bilder.jos-ba-951.workers.dev",

  /* --- 3. Cloudflare Turnstile: Schutz vor Bots -----------*/
  turnstileSiteKey: "0x4AAAAAAEcFE9bsQTXXCkkq",

  /* --- 4. Grenzen der Gratis-Tarife -----------------------                     */
  limits: {
    dbRows:        4000,        // Ereignisse insgesamt (Supabase 500 MB)
    writesPerDay:  1500,        // Speichern, Ändern, Löschen, Kommentare
    readsPerDay:   8000,        // Ladevorgänge der Chronik
    uploadsPerDay: 300,         // Bilder hochladen
    getsPerDay:    50000,       // Bilder anzeigen (Worker: 100.000/Tag)
    storageBytes:  8000000000,  // 8 GB Bilder (R2 gratis: 10 GB)
    egressPerMonth: 4000000000, // 4 GB Datenverkehr (Supabase: 5 GB)
    emailsPerHour: 3            // Bestätigungs- und Passwortmails
  },

  /* --- 5. Heimnetz-Modus (Testbetrieb ohne HTTPS) -------- */
   debug: true,
   homeNetwork: false
};
