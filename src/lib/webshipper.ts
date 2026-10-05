// Integrasjon mot Webshipper API v2 (JSON:API) for å opprette returforsendelse
// og hente fraktetikett (PDF), samt QR-kode-retur (Bring "9350 - Retur til
// Bedrift") som sendes direkte til kunden på SMS/e-post i stedet for PDF.

import { env } from "./env";

const JSON_API_HEADERS = {
  "Content-Type": "application/vnd.api+json",
  Accept: "application/vnd.api+json",
};

function baseUrl() {
  return `https://${env.webshipperAccountName}.api.webshipper.io/v2`;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${env.webshipperAccessToken}`,
  };
}

export interface ReturnShipmentAddress {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  countryCode: string;
  phone?: string | null;
  email?: string | null;
}

export interface ReturnShipmentItem {
  articleNumber: string;
  description: string;
  quantity: number;
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

export interface CreateReturnShipmentParams {
  /** Kundens adresse - varene sendes FRA her. */
  fromAddress: ReturnShipmentAddress;
  items: ReturnShipmentItem[];
  referenceText: string;
  /**
   * Hvilken Webshipper-servicekode forsendelsen skal bruke. Vanlig
   * PDF-etikett og QR-kode-retur er to ulike Bring-produkter/servicekoder
   * på samme Webshipper-konto, så dette avgjør hvilken av dem kunden får.
   */
  serviceCode: string;
}

export interface CreateReturnShipmentResult {
  shipmentId: string;
  trackingNumber?: string;
}

/**
 * Regner ut en samlet "kubepakke" (ett kolli) basert på totalvolumet av
 * alle varelinjene, slik at Webshipper alltid får gyldige mål uansett
 * hvor mange forskjellige varer returen inneholder.
 */
function calculateCubePackage(items: ReturnShipmentItem[]) {
  let totalWeightGrams = 0;
  let totalVolumeCm3 = 0;

  for (const item of items) {
    totalWeightGrams += item.weightGrams * item.quantity;
    totalVolumeCm3 += item.lengthCm * item.widthCm * item.heightCm * item.quantity;
  }

  if (totalWeightGrams <= 0) {
    totalWeightGrams = env.defaultItemWeightGrams;
  }
  if (totalVolumeCm3 <= 0) {
    totalVolumeCm3 =
      env.defaultItemLengthCm * env.defaultItemWidthCm * env.defaultItemHeightCm;
  }

  const sideCm = Math.max(1, Math.cbrt(totalVolumeCm3));

  return {
    weightKg: Math.max(0.1, totalWeightGrams / 1000),
    lengthCm: sideCm,
    widthCm: sideCm,
    heightCm: sideCm,
  };
}

export async function createReturnShipment(
  params: CreateReturnShipmentParams
): Promise<CreateReturnShipmentResult> {
  const warehouse = env.warehouseAddress;
  const pkg = calculateCubePackage(params.items);

  const body = {
    data: {
      type: "shipments",
      attributes: {
        reference: params.referenceText,
        service_code: params.serviceCode,
        is_return: true,
        sender_address: {
          att_contact: params.fromAddress.name,
          address_1: params.fromAddress.street,
          zip: params.fromAddress.postalCode,
          city: params.fromAddress.city,
          country_code: params.fromAddress.countryCode,
          phone: params.fromAddress.phone || undefined,
          email: params.fromAddress.email || undefined,
        },
        delivery_address: {
          company_name: warehouse.name,
          address_1: warehouse.street,
          zip: warehouse.postalCode,
          city: warehouse.city,
          country_code: warehouse.countryCode,
        },
        packages: [
          {
            weight: pkg.weightKg * 1000,
            weight_unit: "g",
            dimensions: {
              length: pkg.lengthCm,
              width: pkg.widthCm,
              height: pkg.heightCm,
              unit: "cm",
            },
          },
        ],
      },
      relationships: {
        carrier: { data: { id: env.webshipperCarrierId, type: "carriers" } },
      },
    },
  };

  const res = await fetch(`${baseUrl()}/shipments`, {
    method: "POST",
    headers: { ...JSON_API_HEADERS, ...authHeaders() },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Webshipper: kunne ikke opprette returforsendelse (${res.status}): ${text}`
    );
  }

  const json = await res.json();
  const shipmentId = json?.data?.id;
  const trackingNumber = json?.data?.attributes?.tracking_number;

  if (!shipmentId) {
    throw new Error("Webshipper: mottok ikke forsendelses-ID i svaret.");
  }

  return { shipmentId: String(shipmentId), trackingNumber };
}

export interface LabelFetchResult {
  labelPdfBase64?: string;
  labelUrl?: string;
}

/**
 * Henter etiketten for en forsendelse. Kalles ETTER at returordren er
 * opprettet i Ongoing, med et kort og begrenset antall forsøk - Webshipper
 * trenger noen sekunder på å generere etiketten, men vi har ikke tid (eller
 * kritisk behov) til å vente lenge på Vercel Hobby sin ~10s kjøretidsgrense.
 *
 * Kalles KUN for vanlig PDF-etikett-flyt - ved QR-kode-retur finnes det
 * ingen PDF å hente (Bring sender QR-koden direkte til kunden), så dette
 * steget hoppes over i /api/return for den flyten.
 */
export async function fetchLabelForShipment(
  shipmentId: string,
  attempts = 3,
  delayMs = 500
): Promise<LabelFetchResult> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${baseUrl()}/shipments/${shipmentId}/labels`, {
        method: "GET",
        headers: { ...JSON_API_HEADERS, ...authHeaders() },
      });

      if (res.ok) {
        const json = await res.json();
        const entry = Array.isArray(json?.data) ? json.data[0] : json?.data;
        const base64 = entry?.attributes?.base64;
        const url = entry?.attributes?.label_url || entry?.attributes?.url;
        if (base64 || url) {
          return { labelPdfBase64: base64 || undefined, labelUrl: url || undefined };
        }
      }
    } catch {
      // Ignorer og prøv igjen - etiketten kan fortsatt være under generering.
    }

    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Ikke kritisk: returordren er allerede opprettet i Ongoing uansett.
  return {};
}
