/* ============================================================
   CHRONIK — Verbindungen und Grenzen
   ============================================================
   Diese Datei ist die einzige, die du anpassen musst.
   Alle Werte dürfen öffentlich sein: Geschützt wird durch die
   Regeln in der Datenbank, nicht durch Geheimhaltung.
   Leere Felder = die jeweilige Funktion bleibt einfach aus.
   ============================================================ */

window.CHRONIK_CONFIG = {

  /* --- 1. Supabase: Konten, Ereignisse, Kommentare ---------
     Supabase → Project Settings → API
       url     = "Project URL"
       anonKey = "anon public" (der lange Text mit ey… am Anfang)
     Leer lassen = Einzelplatz-Modus, alles bleibt im Browser.   */
  url: "https://mhdjmuyfccyfeoffplbk.supabase.co/rest/v1",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1oZGptdXlmY2N5ZmVvZmZwbGJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2Nzc5NDIsImV4cCI6MjEwMzI1Mzk0Mn0.bIIEMuwjjRglIa74A-4xVUixiVKKdJiYzb2p1SH9FAE",

  /* --- 2. Cloudflare R2: die Bilder -----------------------
     Adresse deines Workers, ohne Schrägstrich am Ende, z. B.
     "https://chronik-bilder.deinname.workers.dev"
     Leer lassen = Bilder gehen in den Supabase-Speicher.        */
  r2Worker: "chronik-bilder.jos-ba-951.workers.dev",

  /* --- 3. Cloudflare Turnstile: Schutz vor Bots ------------
     Cloudflare → Turnstile → Add site → "Site Key" hierher.
     Leer lassen = die Chronik stellt stattdessen selbst eine
     kleine Rechenaufgabe.                                      */
  turnstileSiteKey: "0x4AAAAAAEcFE9bsQTXXCkkq",

  /* --- 4. Grenzen der Gratis-Tarife -----------------------
     Bewusst unter den echten Grenzen (Sicherheitsabstand), damit
     nie Kosten entstehen. Wird eine Grenze erreicht, startet die
     Chronik die Aktion nicht und erklärt in einfachen Worten,
     was los ist und wann es weitergeht.                        */
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

  /* --- 5. Heimnetz-Modus (Testbetrieb ohne HTTPS) ---------
     true = die Chronik darf auch auf http://192.168… laufen und
     dort Konten anlegen. Nur fürs eigene Netz gedacht; im
     Internet immer false lassen.                               */
  homeNetwork: true
};
