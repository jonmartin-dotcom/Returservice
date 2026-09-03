// Klient mot Webshipper API v2 - brukes til å opprette returforsendelsen og
// hente fraktetiketten (PDF) som skal gis til kunden.
//
// Dokumentasjon: https://docs.webshipper.io/
// Webshipper bruker JSON:API-format og OAuth2 (Bearer-token). Enklest er å lage
// en "Access token" direkte i Webshipper-grensesnittet under
// Settings -> Access and tokens, og bruke den som WEBSHIPPER_ACCESS_TOKEN.
//
// VIKTIG Å VERIFISERE MOT DERES EGEN WEBSHIPPER-KONTO FØR PRODUKSJON:
// - Webshipper sitt eget "Return"-ressurs (POST /v2/returns) er ikke offentlig
//   detaljert dokumentert med alle felter i det jeg har hatt tilgang til her.
//   Strukturen under er basert på det generelle forsendelses-API-et (POST
//   /v2/shipments) og bør verifiseres/justeres mot Webshipper sin support eller
//   Postman-samling (linket fra docs.webshipper.io) før dette går i produksjon.
// - carrier-ID og service_code for returtjenesten (Bring retur) må hentes fra
//   deres egen Webshipper-konto (Settings -> Carriers).
// - Vurder å teste mot Webshipper sitt test-/sandkasse-miljø først, om de tilbyr det.

import { env } from "./env";

function baseUrl(): string {
  return `https://${env.webshipperAccountName}.api.webshipper.io/v2`;
}

async function webshipperFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.webshipperAccessToken}`,
      // Webshipper følger JSON:API-spesifikasjonen strengt og krever denne
      // spesifikke content-typen (bekreftet av feilmelding fra deres API:
      // "All requests that create or update must use the
      // 'application/vnd.api+json' Content-Type").
      "Content-Type": "application/vnd.api+json",
      Accept: "application/vnd.api+json",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
}

export interface CustomerAddress {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  countryCode: string;
  email?: string;
  phone?: string;
}

export interface PackageDimensions {
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

export interface CreateReturnLabelParams {
  reference: string; // f.eks. returordrenummeret, for sporbarhet i Webshipper
  customer: CustomerAddress;
  /** Pakkens vekt og mål. Webshipper krever enten volum eller mål på pakken. */
  package: PackageDimensions;
}

export interface CreateReturnLabelResult {
  success: boolean;
  trackingNumber?: string;
  trackingUrl?: string;
  labelPdfBase64?: string;
  errorMessage?: string;
}

/**
 * Oppretter en returforsendelse hos Webshipper (kunde -> lager) og henter ut
 * fraktetiketten som PDF (base64), slik at kunden kan skrive den ut selv.
 */
export async function createReturnLabel(
  params: CreateReturnLabelParams
): Promise<CreateReturnLabelResult> {
  const warehouse = env.warehouseAddress;

  const shipmentBody = {
    data: {
      type: "shipments",
      attributes: {
        reference: params.reference,
        service_code: env.webshipperServiceCode,
        is_return: true,
        packages: [
          {
            weight: params.package.weightGrams,
            weight_unit: "g",
            dimensions: {
              length: params.package.lengthCm,
              width: params.package.widthCm,
              height: params.package.heightCm,
              unit: "cm",
            },
          },
        ],
        // Ved en returforsendelse er avsender kunden, og mottaker lageret.
        // NB: Webshipper sitt adresseskjema bruker andre feltnavn enn det man
        // skulle tro - "name" finnes ikke, personnavn skal i "att_contact",
        // gateadresse er "address_1" (ikke "address_line_1"), og postnummer
        // er "zip" (ikke "zip_code"). Bekreftet mot docs.webshipper.io.
        sender_address: {
          att_contact: params.customer.name,
          address_1: params.customer.street,
          zip: params.customer.postalCode,
          city: params.customer.city,
          country_code: params.customer.countryCode,
          email: params.customer.email,
          phone: params.customer.phone,
        },
        delivery_address: {
          company_name: warehouse.name,
          address_1: warehouse.street,
          zip: warehouse.postalCode,
          city: warehouse.city,
          country_code: warehouse.countryCode,
        },
      },
      relationships: {
        carrier: { data: { id: env.webshipperCarrierId, type: "carriers" } },
      },
    },
  };

  let shipmentRes: Response;
  try {
    shipmentRes = await webshipperFetch("/shipments", {
      method: "POST",
      body: JSON.stringify(shipmentBody),
    });
  } catch (err) {
    return {
      success: false,
      errorMessage: `Klarte ikke å kontakte Webshipper: ${(err as Error).message}`,
    };
  }

  const shipmentJson = await shipmentRes.json().catch(() => null);

  if (!shipmentRes.ok) {
    const message =
      shipmentJson?.errors?.[0]?.detail || `Webshipper avviste forsendelsen (${shipmentRes.status}).`;
    return { success: false, errorMessage: message };
  }

  const shipmentId: string | undefined = shipmentJson?.data?.id;
  const trackingNumber: string | undefined = shipmentJson?.data?.attributes?.tracking_number;
  const trackingUrl: string | undefined = shipmentJson?.data?.attributes?.tracking_url;

  if (!shipmentId) {
    return {
      success: false,
      errorMessage: "Fikk ikke noen forsendelses-ID tilbake fra Webshipper.",
    };
  }

  // Etiketten er en egen ressurs (labels) som Webshipper genererer i
  // bakgrunnen når forsendelsen opprettes - den er ikke alltid klar med det
  // samme. Vi finner den via GET /labels?filter[shipment_id]=X og prøver noen
  // ganger med kort mellomrom hvis den ikke er klar ennå.
  const label = await fetchLabelForShipment(shipmentId);

  // Logges til Vercel sine funksjonslogger (Deployments -> velg deployment ->
  // fanen "Logs" eller "Runtime Logs") slik at vi kan se nøyaktig hva
  // Webshipper svarte, i tilfelle etiketten fortsatt ikke hentes automatisk.
  console.log("[webshipper] shipmentId=%s labelLookup=%o", shipmentId, label);

  if (!label.base64PDF) {
    return {
      success: true,
      trackingNumber,
      trackingUrl,
      errorMessage: `Fant ikke etikett-PDF automatisk (shipmentId=${shipmentId}, ${label.diagnostic || "ingen diagnostikk"}). Se Vercel-loggene for detaljer, eller sjekk forsendelsen direkte i Webshipper.`,
    };
  }

  return {
    success: true,
    trackingNumber,
    trackingUrl,
    labelPdfBase64: label.base64PDF,
  };
}

interface LabelLookupResult {
  labelId?: string;
  base64PDF?: string;
  diagnostic?: string;
}

async function fetchLabelForShipment(shipmentId: string): Promise<LabelLookupResult> {
  const maxAttempts = 5;
  const delayMs = 800;
  let lastDiagnostic = "";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Webshipper tillater ikke filter[shipment_id] på /labels (bekreftet av
      // feilmelding: "Filter not allowed - shipment_id is not allowed").
      // Riktig vei er i stedet shipment sin egen "labels"-relasjon:
      // GET /v2/shipments/{id}/labels (bekreftet mot docs.webshipper.io).
      const res = await webshipperFetch(`/shipments/${encodeURIComponent(shipmentId)}/labels`);
      const bodyText = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(bodyText);
      } catch {
        // ikke gyldig JSON - fortsetter med diagnostikk under
      }
      console.log(
        "[webshipper] shipments/%s/labels (forsøk %d) status=%d body=%s",
        shipmentId,
        attempt + 1,
        res.status,
        bodyText.slice(0, 500)
      );

      if (res.ok) {
        const j = json as { data?: Array<{ id?: string; attributes?: { base64?: string } }> } | null;
        const entry = Array.isArray(j?.data) ? j?.data[0] : undefined;
        const base64: string | undefined = entry?.attributes?.base64 || undefined;
        if (entry?.id && base64) {
          return { labelId: entry.id, base64PDF: base64 };
        }
        if (entry?.id) {
          // Etiketten finnes men er ikke ferdig generert ennå (base64 er null) -
          // hent den direkte på ID-en i tilfelle det gir et ferskere svar.
          const directRes = await webshipperFetch(`/labels/${entry.id}`);
          const directBodyText = await directRes.text();
          console.log(
            "[webshipper] labels/%s (forsøk %d) status=%d body=%s",
            entry.id,
            attempt + 1,
            directRes.status,
            directBodyText.slice(0, 500)
          );
          if (directRes.ok) {
            const directJson = JSON.parse(directBodyText || "null") as {
              data?: { attributes?: { base64?: string } };
            } | null;
            const directBase64 = directJson?.data?.attributes?.base64;
            if (directBase64) return { labelId: entry.id, base64PDF: directBase64 };
          }
          lastDiagnostic = `etikett-ID ${entry.id} funnet, men base64 fortsatt tom etter ${attempt + 1} forsøk`;
        } else {
          lastDiagnostic = `ingen etikett i listen ennå (status ${res.status}) etter ${attempt + 1} forsøk`;
        }
      } else {
        lastDiagnostic = `filter-kall feilet med status ${res.status}: ${bodyText.slice(0, 200)}`;
      }
    } catch (err) {
      lastDiagnostic = `nettverksfeil: ${(err as Error).message}`;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return { diagnostic: lastDiagnostic };
}
