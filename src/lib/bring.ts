// Integrasjon mot Bring sitt eget Booking API (developer.bring.com/api/booking/)
// for å opprette returforsendelse - enten med vanlig PDF-etikett, eller med
// QR-kode/etikettfri kode sendt til kunden på SMS/e-post.
//
// Erstatter lib/webshipper.ts. Grunnen til byttet: vi fikk aldri QR-kode-
// utsendelsen til å fungere pålitelig via Webshipper (se prosjektnotatet,
// avsnittet om Nesco sitt uavklarte SMS/e-post-problem) - ved å gå direkte
// mot Bring sitt eget API har vi full kontroll på feltet `generateQrCodes`,
// som er dokumentert og bekreftet å finnes i Bring sin egen API-spesifikasjon
// (hentet fra https://api.bring.com/booking/api-docs, nov. 2026).
//
// Viktige kilder (les disse FØR du endrer noe her, for å unngå å gjette feil
// struktur slik det skjedde med Webshipper under Almea-oppsettet):
//   https://developer.bring.com/api/booking/
//   https://developer.bring.com/api/services/  (produktkode-oversikt)
//   https://api.bring.com/booking/api-docs      (maskinlesbar OpenAPI-spec)

import { env } from "./env";

function baseUrl() {
  return "https://api.bring.com/booking/api";
}

function authHeaders() {
  return {
    "X-MyBring-API-Uid": env.bringApiUid,
    "X-MyBring-API-Key": env.bringApiKey,
    "X-Bring-Test-Indicator": env.bringTestIndicator ? "true" : "false",
  };
}

const JSON_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
};

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

export type ReturnDeliveryMethod = "LABEL" | "QR";

export interface CreateReturnShipmentParams {
  /** Kundens adresse - varene sendes FRA her. */
  fromAddress: ReturnShipmentAddress;
  items: ReturnShipmentItem[];
  referenceText: string;
  /**
   * "LABEL" = vanlig nedlastbar PDF-etikett (Bring-produkt 9300, "Return
   * from pick-up point"). "QR" = etikettfri retur der kunden får en QR-kode/
   * kode tilsendt (Bring-produkt 9350, "Return parcel to business", med
   * generateQrCodes slått på). Se Bring sin Service Portfolio for koder.
   */
  deliveryMethod: ReturnDeliveryMethod;
}

export interface CreateReturnShipmentResult {
  consignmentNumber: string;
  trackingUrl?: string;
  labelPdfBase64?: string;
  labelUrl?: string;
  /** Kun satt når deliveryMethod === "QR". Lenke til en PNG av selve QR-koden. */
  qrCodeLink?: string;
  /** Kun satt når deliveryMethod === "QR". Kode kunden kan skrive på pakken
   *  manuelt dersom QR-skanning ikke er tilgjengelig (f.eks. "BRING-1234-5678"). */
  labelFreeCode?: string;
}

/**
 * Regner ut en samlet "kubepakke" (ett kolli) basert på totalvolumet av alle
 * varelinjene, slik at Bring alltid får gyldige mål uansett hvor mange
 * forskjellige varer returen inneholder. Samme fremgangsmåte som i
 * lib/webshipper.ts tidligere - kun flyttet hit.
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

  const sideCm = Math.max(1, Math.ceil(Math.cbrt(totalVolumeCm3)));

  return {
    weightKg: Math.max(0.1, totalWeightGrams / 1000),
    lengthCm: sideCm,
    widthCm: sideCm,
    heightCm: sideCm,
  };
}

/**
 * Henter PDF-bytes for en etikett-URL og returnerer dem som base64, slik at
 * frontend kan vise/laste ned etiketten uten å måtte følge Bring sin egen
 * redirect selv (labels.link peker via en 302 til endelig lagringssted, jf.
 * Bring sin dokumentasjon - "Ensure that your client follows these
 * redirects").
 */
async function fetchLabelAsBase64(labelUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(labelUrl, { redirect: "follow" });
    if (!res.ok) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString("base64");
  } catch {
    return undefined;
  }
}

export async function createReturnShipment(
  params: CreateReturnShipmentParams
): Promise<CreateReturnShipmentResult> {
  const warehouse = env.warehouseAddress;
  const pkg = calculateCubePackage(params.items);
  const isQr = params.deliveryMethod === "QR";

  const productId = isQr ? env.bringQrReturnProductId : env.bringReturnProductId;

  // Merk: for returer er avsenders telefonnummer IKKE påkrevd hos Bring
  // ("Exceptions to this rule are ... and all return services" - Bring sin
  // Booking-dokumentasjon), men e-post ER påkrevd når generateQrCodes er på
  // ("The sender's email address is required in the booking request").
  const body = {
    consignments: [
      {
        product: {
          id: productId,
          customerNumber: env.bringCustomerNumber,
        },
        parties: {
          sender: {
            name: params.fromAddress.name,
            addressLine: params.fromAddress.street,
            postalCode: params.fromAddress.postalCode,
            city: params.fromAddress.city,
            countryCode: params.fromAddress.countryCode,
            contact: {
              name: params.fromAddress.name,
              email: params.fromAddress.email || undefined,
              phoneNumber: params.fromAddress.phone || undefined,
            },
          },
          recipient: {
            name: warehouse.name,
            addressLine: warehouse.street,
            postalCode: warehouse.postalCode,
            city: warehouse.city,
            countryCode: warehouse.countryCode,
          },
        },
        packages: [
          {
            weightInKg: pkg.weightKg,
            dimensions: {
              heightInCm: pkg.heightCm,
              lengthInCm: pkg.lengthCm,
              widthInCm: pkg.widthCm,
            },
          },
        ],
        shippingDateTime: new Date().toISOString(),
        references: { sendersReference: params.referenceText },
        ...(isQr ? { generateQrCodes: true } : {}),
      },
    ],
  };

  const res = await fetch(`${baseUrl()}/create`, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...authHeaders() },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => undefined);

  if (!res.ok) {
    throw new Error(
      `Bring: kunne ikke opprette returforsendelse (${res.status}): ${JSON.stringify(
        json
      )}`
    );
  }

  const consignment = json?.consignments?.[0];
  const errors = consignment?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`Bring: feil i booking-svar: ${JSON.stringify(errors)}`);
  }

  const confirmation = consignment?.confirmation;
  const consignmentNumber = confirmation?.consignmentNumber;
  if (!consignmentNumber) {
    throw new Error(
      `Bring: mottok ikke consignmentNumber i svaret: ${JSON.stringify(json)}`
    );
  }

  const pkgConfirmation = confirmation?.packages?.[0];

  let labelPdfBase64: string | undefined = confirmation?.labels?.base64;
  const labelUrl: string | undefined =
    confirmation?.labels?.link || confirmation?.links?.labels;

  // Bring returnerer ofte kun en lenke (ikke base64 direkte) - hent selv slik
  // at frontend-flyten er identisk med det vi hadde med Webshipper.
  if (!labelPdfBase64 && labelUrl && !isQr) {
    labelPdfBase64 = await fetchLabelAsBase64(labelUrl);
  }

  return {
    consignmentNumber: String(consignmentNumber),
    trackingUrl: confirmation?.links?.tracking,
    labelPdfBase64,
    labelUrl,
    qrCodeLink: pkgConfirmation?.qrCodeLink,
    labelFreeCode: pkgConfirmation?.labelFreeCode,
  };
}
