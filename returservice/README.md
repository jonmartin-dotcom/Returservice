# Returservice

En returservice-løsning (som Colliflow-skjemaet dere hadde tidligere), tilpasset
deres eget oppsett med **Ongoing WMS** (lager) og **Webshipper** (frakt/Bring).

Kunden fyller ut ordrenummer, velger hvilke varer som returneres og hvorfor, og
får en fraktetikett tilbake. Samtidig opprettes det automatisk en returordre i
Ongoing WMS, slik at lagermedarbeider finner returen igjen når varen kommer inn.

## Hvordan det fungerer

1. Kunden oppgir ordrenummer → løsningen slår opp ordren i Ongoing WMS og viser
   varelinjene (`POST /api/order/lookup`).
2. Kunden velger varer, antall og returårsak, samt kontaktinfo og adresse.
3. Ved innsending (`POST /api/return`):
   - Det opprettes en returforsendelse hos **Webshipper**, som genererer en
     fraktetikett (PDF) via deres Bring-avtale.
   - Det opprettes en returordre i **Ongoing WMS** via `PUT /api/v1/returnOrders`,
     med sporingsnummeret fra etiketten lagt inn, slik at returen er søkbar for
     lagermedarbeider når varen kommer inn (Ordre → Returordreliste).
   - Kunden får etiketten til nedlasting.

## Før dette kan gå i produksjon — MÅ verifiseres

Jeg har bygget integrasjonene mot Ongoing WMS sitt offisielt dokumenterte REST-API
(https://developer.ongoingwarehouse.com/REST/v1/index.html), så feltnavn og
struktur der bør stemme. For Webshipper har jeg derimot ikke hatt tilgang til en
konto for å teste mot virkeligheten, så følgende **må** kontrolleres/justeres av
noen med tilgang til deres Webshipper-konto før dere setter dette i drift:

- Nøyaktig format på `POST /v2/shipments` for en returforsendelse
  (`is_return: true`), og om Webshipper heller forventer at dette gjøres via en
  egen `/v2/returns`-ressurs. Se https://docs.webshipper.io/ eller kontakt
  Webshipper support/deres kontaktperson der.
- Riktig `WEBSHIPPER_CARRIER_ID` og `WEBSHIPPER_SERVICE_CODE` for Bring-returtjenesten
  slik den er satt opp i deres konto (Settings → Carriers i Webshipper).
- At API-brukeren i Ongoing WMS har fått tilgang til "Goods Owner Returns REST API"
  under Administration → API for goods owner (kreves for å opprette returordre).

Jeg anbefaler å teste hele flyten med én reell ordre i et testmiljø (Ongoing har et
eget demo-miljø, se `ONGOING_USE_DEMO_SERVER`) før dere deler lenken med kunden.

## Oppsett lokalt

```bash
npm install
cp .env.example .env.local   # fyll inn verdiene
npm run dev
```

Åpne http://localhost:3000.

## Driftsetting (anbefalt: Vercel)

Siden dere ikke hadde en hosting-løsning fra før, anbefaler jeg Vercel — det er
gratis for denne typen bruk, krever ikke egen serverdrift, og fungerer sømløst
med Next.js (som denne løsningen er bygget i):

1. Opprett en konto på https://vercel.com (kan kobles til GitHub).
2. Last opp denne mappen til et GitHub-repo, eller kjør `npx vercel` fra denne
   mappen for å deploye direkte fra kommandolinjen.
3. I Vercel-prosjektet: gå til Settings → Environment Variables og legg inn alle
   variablene fra `.env.example`.
4. Deploy. Dere får en lenke i stil med `https://returservice-xyz.vercel.app`,
   som kan pekes til med egen domene/subdomene senere om ønskelig
   (f.eks. `retur.dereslager.no`).
5. Kunden kan lenke til denne siden fra sin nettbutikk, akkurat som med
   Colliflow-lenken tidligere.

## Branding

Skjemaet er nå nøytralt (grønn aksentfarge, "LOGO"-plassholder øverst). Når dere
vet hvilken kunde dette skal brukes for, bytt ut:

- Logo/tekst i `src/app/page.tsx` (`logoSlot`-delen)
- Aksentfarge i `src/app/globals.css` (`--accent`)
- Introteksten om returvilkår i `src/app/page.tsx` (`intro`-delen) — teksten der
  er en generisk plassholder og bør erstattes med kundens faktiske returvilkår
  (frist, evt. returgebyr, o.l.)

## Struktur

```
src/
  lib/
    env.ts         - sentral lesing av miljøvariabler
    types.ts       - delte typer
    ongoing.ts      - Ongoing WMS-klient (ordreoppslag + opprett returordre)
    webshipper.ts   - Webshipper-klient (returforsendelse + hent etikett)
  app/
    page.tsx        - selve returskjemaet (3 steg)
    page.module.css
    api/
      order/lookup/route.ts  - POST: slå opp ordre
      return/route.ts        - POST: opprett retur (Webshipper + Ongoing)
```

## Sikkerhet

- All kommunikasjon med Ongoing WMS og Webshipper skjer server-side (API-nøkler
  ligger kun i miljøvariabler på serveren, aldri i nettleseren).
- Ordren slås opp på nytt server-side ved innsending (stoler ikke på det klienten
  sendte inn), og antall som returneres valideres mot hva som faktisk kan
  returneres på ordren.
