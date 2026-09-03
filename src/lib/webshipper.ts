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

  const shipmentId = shipmentJson?.data?.id;
  const trackingNumber: string | undefined = shipmentJson?.data?.attributes?.tracking_number;
  const trackingUrl: string | undefined = shipmentJson?.data?.attributes?.tracking_url;
  const labelId: string | undefined =
    shipmentJson?.data?.relationships?.label?.data?.id || shipmentId;

  if (!labelId) {
    return {
      success: false,
      errorMessage: "Fikk ikke noen etikett-ID tilbake fra Webshipper.",
    };
  }

  let labelRes: Response;
  try {
    labelRes = await webshipperFetch(`/labels/${labelId}`);
  } catch (err) {
    return {
      success: false,
      errorMessage: `Forsendelse opprettet, men klarte ikke å hente etiketten: ${(err as Error).message}`,
    };
  }

  const labelJson = await labelRes.json().catch(() => null);

  if (!labelRes.ok) {
    return {
      success: false,
      errorMessage: `Forsendelse opprettet, men Webshipper avviste etikett-forespørselen (${labelRes.status}).`,
    };
  }

  const labelPdfBase64: string | undefined = labelJson?.data?.attributes?.label;

  return {
    success: true,
    trackingNumber,
    trackingUrl,
    labelPdfBase64,
  };
}
