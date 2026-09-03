// Klient mot Ongoing WMS Goods Owner REST API.
//
// Dokumentasjon: https://developer.ongoingwarehouse.com/REST/v1/index.html
// Feltnavn under er hentet direkte fra Ongoing sin offisielle OpenAPI-spesifikasjon
// (https://developer.ongoingwarehouse.com/REST/v1/openapi.json), hentet 2026-09-03.
// Autentisering skjer med HTTP Basic Auth (brukernavn/passord fra "API for goods
// owner" i Ongoing WMS administrasjon) - ikke API-nøkkel i header.
//
// VIKTIG Å VERIFISERE MOT DERES EGEN ONGOING-KONTO FØR PRODUKSJON:
// - At {warehouse}-verdien i URLen stemmer med subdomenet dere logger inn med
//   (https://{warehouse}.ongoingsystems.se/{warehouse}).
// - At API-brukeren har fått tilgang til "Goods Owner Returns REST API" i
//   Administration -> API for goods owner (kreves for å opprette returordre,
//   se https://developer.ongoingwarehouse.com/REST/v1/index.html "Extension APIs").
// - At ONGOING_GOODS_OWNER_ID stemmer med denne kundens goodsOwnerId i Ongoing.

import { env } from "./env";
import type { OrderLookupResponse, OrderLineForCustomer, ReturnLineSelection } from "./types";

function baseUrl(): string {
  const wh = env.ongoingWarehouse;
  const host = env.ongoingUseDemoServer ? "wms1" : "api";
  return `https://${host}.ongoingsystems.se/${wh}/api/v1`;
}

function authHeader(): string {
  const token = Buffer.from(`${env.ongoingUsername}:${env.ongoingPassword}`).toString("base64");
  return `Basic ${token}`;
}

async function ongoingFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers || {}),
    },
    // Ongoing sitt API kan være tregt under høy last - gi det litt tid.
    signal: AbortSignal.timeout(20_000),
  });
}

/**
 * MIDLERTIDIG DEBUG-FUNKSJON: henter det helt rå, ubehandlede svaret fra
 * Ongoing for en ordre, uten noen tolkning av feltnavn. Brukes av
 * /api/debug/order-lookup for å finne de faktiske feltnavnene for
 * telefon/e-post på consignee-objektet. Fjern denne + API-ruten når det er
 * bekreftet og "advanced"/"invoiceAddress"-feltnavnene er lagt inn riktig i
 * pickConsigneeField-kallene.
 */
export async function getRawOrderForDebug(orderNumber: string): Promise<unknown> {
  const params = new URLSearchParams({
    goodsOwnerId: String(env.ongoingGoodsOwnerId),
    orderNumber: orderNumber.trim(),
  });
  const res = await ongoingFetch(`/orders?${params.toString()}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text, status: res.status };
  }
}

// --- Typer som gjenspeiler et utvalg av Ongoing sin GetOrderModel/GetOrderLine ---
// (Kun feltene vi faktisk trenger er tatt med - det fulle svaret inneholder mye mer,
// se GetOrderModel i openapi.json om dere trenger flere felter.)

interface OngoingOrderArticle {
  articleNumber?: string;
  articleName?: string;
}

interface OngoingOrderLine {
  id: number;
  rowNumber?: string;
  article?: OngoingOrderArticle | null;
  orderedNumberOfItems: number;
  returnedNumberOfItems?: number;
}

interface OngoingOrderInfo {
  orderId: number;
  orderNumber?: string;
}

interface OngoingOrderModel {
  orderInfo?: OngoingOrderInfo | null;
  // "consignee" er typet løst med vilje (ikke et fast interface) - se
  // pickConsigneeField under for hvorfor: de eksakte feltnavnene for
  // adresse/telefon i GET /orders-svaret har vist seg vanskelige å bekrefte
  // fra dokumentasjonen alene, så vi prøver flere kjente varianter i stedet.
  consignee?: Record<string, unknown> | null;
  orderLines?: OngoingOrderLine[] | null;
}

/**
 * Henter en verdi fra "consignee"-objektet på ordren, og prøver flere kjente
 * varianter av feltnavn (både flate og eventuelt nøstet under et
 * "address"/"consigneeAddress"-underobjekt), siden Ongoing sin REST v1
 * dokumentasjon for disse feltnavnene ikke lot seg bekrefte fullt ut.
 */
function pickConsigneeField(
  consignee: Record<string, unknown> | null | undefined,
  keys: string[]
): string | null {
  if (!consignee) return null;

  for (const key of keys) {
    const value = consignee[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }

  // Noen WMS-er nøster adressefeltene under et eget "address"-objekt.
  const nestedCandidates = [
    "address",
    "consigneeAddress",
    "deliveryAddress",
    "advanced",
    "invoiceAddress",
  ];
  for (const nestedKey of nestedCandidates) {
    const nested = consignee[nestedKey];
    if (nested && typeof nested === "object") {
      const found = pickConsigneeField(nested as Record<string, unknown>, keys);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Slår opp en ordre på ordrenummer for den konfigurerte varemottakeren (goods owner),
 * og returnerer et forenklet objekt med linjene kunden kan velge å returnere.
 */
export async function lookupOrderByNumber(orderNumber: string): Promise<OrderLookupResponse> {
  const params = new URLSearchParams({
    goodsOwnerId: String(env.ongoingGoodsOwnerId),
    orderNumber: orderNumber.trim(),
  });

  let res: Response;
  try {
    res = await ongoingFetch(`/orders?${params.toString()}`);
  } catch (err) {
    return {
      found: false,
      reason: "ERROR",
      message: `Klarte ikke å kontakte Ongoing WMS: ${(err as Error).message}`,
    };
  }

  if (!res.ok) {
    return {
      found: false,
      reason: "ERROR",
      message: `Ongoing WMS svarte med feil (${res.status}).`,
    };
  }

  const orders = (await res.json()) as OngoingOrderModel[];
  const order = orders?.[0];

  if (!order || !order.orderInfo) {
    return {
      found: false,
      reason: "NOT_FOUND",
      message: "Fant ingen ordre med dette ordrenummeret.",
    };
  }

  // Midlertidig diagnostikk (se Vercel -> Logs): viser nøyaktig hvilke
  // feltnavn Ongoing faktisk bruker på consignee-objektet, slik at vi kan
  // bekrefte/justere feltnavnene under ved behov.
  // Bruker JSON.stringify (ikke %o) slik at nøstede objekter som "advanced"
  // og "invoiceAddress" - der telefon/e-post trolig ligger - vises fullt ut
  // i loggen i stedet for forkortet til "{…}".
  console.log("[ongoing] consignee=" + JSON.stringify(order.consignee, null, 2));

  const lines: OrderLineForCustomer[] = (order.orderLines || []).map((line) => ({
    orderLineId: line.id,
    rowNumber: line.rowNumber || String(line.id),
    articleNumber: line.article?.articleNumber || "",
    articleName: line.article?.articleName || line.article?.articleNumber || "Ukjent vare",
    orderedNumberOfItems: line.orderedNumberOfItems,
    alreadyReturnedNumberOfItems: line.returnedNumberOfItems || 0,
  }));

  const consignee = order.consignee || null;

  return {
    found: true,
    orderId: order.orderInfo.orderId,
    orderNumber: order.orderInfo.orderNumber || orderNumber,
    customerName: pickConsigneeField(consignee, ["name", "consigneeName", "fullName"]) || "",
    customerEmail: pickConsigneeField(consignee, ["emailAddress", "email"]),
    customerPhone: pickConsigneeField(consignee, [
      "phoneNumber",
      "mobilePhone",
      "mobileTelephone",
      "telephone",
      "phone",
      "mobile",
      "cellPhone",
    ]),
    customerStreet: pickConsigneeField(consignee, [
      "streetAddressLine1",
      "streetAddress1",
      "address1",
      "address",
      "addressLine1",
      "street",
    ]),
    customerPostalCode: pickConsigneeField(consignee, [
      "postalCode",
      "postCode",
      "zipCode",
      "zip",
    ]),
    customerCity: pickConsigneeField(consignee, ["city", "town", "postalArea"]),
    customerCountryCode: pickConsigneeField(consignee, ["countryCode", "country"]),
    lines,
  };
}

export interface ArticlePackageInfo {
  weightKg?: number;
  lengthM?: number;
  widthM?: number;
  heightM?: number;
}

/**
 * Henter vekt/mål for et sett med varenumre fra Ongoing (GET /api/v1/articles),
 * slik at vi kan sende reelle pakkemål til Webshipper i stedet for gjetning.
 *
 * NB: Ongoing sin REST v1 dokumentasjon for artikkel-feltnavn var ikke
 * tilgjengelig i sin helhet da dette ble skrevet. Feltnavn her er derfor
 * basert på det som er kjent fra Ongoing sitt datamodell for øvrig (vekt i
 * kg, mål i meter) og sjekkes mot flere vanlige varianter av feltnavn for å
 * være mest mulig robust. Hvis dette viser seg å ikke stemme mot deres
 * faktiske API-svar, bruk feilmeldingen/loggen til å justere feltnavnene i
 * `pickNumber`-kallene under.
 */
export async function getArticlePackageInfo(
  articleNumbers: string[]
): Promise<Map<string, ArticlePackageInfo>> {
  const uniqueNumbers = Array.from(new Set(articleNumbers.filter(Boolean)));
  const result = new Map<string, ArticlePackageInfo>();

  await Promise.all(
    uniqueNumbers.map(async (articleNumber) => {
      try {
        const params = new URLSearchParams({
          goodsOwnerId: String(env.ongoingGoodsOwnerId),
          articleNumber,
        });
        const res = await ongoingFetch(`/articles?${params.toString()}`);
        if (!res.ok) return;
        const json = await res.json().catch(() => null);
        const article = Array.isArray(json) ? json[0] : json;
        if (!article || typeof article !== "object") return;

        const a = article as Record<string, unknown>;
        result.set(articleNumber, {
          weightKg: pickNumber(a, ["weight", "grossWeight", "netWeight"]),
          lengthM: pickNumber(a, ["length", "articleLength"]),
          widthM: pickNumber(a, ["width", "articleWidth"]),
          heightM: pickNumber(a, ["height", "articleHeight"]),
        });
      } catch {
        // Fortsetter uten mål for denne varen - vi faller tilbake på
        // standardmål i webshipper.ts-kallet.
      }
    })
  );

  return result;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && value > 0) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      if (!Number.isNaN(n) && n > 0) return n;
    }
  }
  return undefined;
}

export interface CreateReturnOrderParams {
  /** Ongoing sin interne orderId for salgsordren (fra lookupOrderByNumber). */
  orderId: number;
  returnOrderNumber: string;
  reasonCode: string;
  reasonLabel: string;
  comment: string;
  lines: ReturnLineSelection[];
  trackingNumber?: string;
  trackingUrl?: string;
}

export interface CreateReturnOrderResult {
  success: boolean;
  returnOrderId?: number;
  errorMessage?: string;
}

/**
 * Oppretter en returordre i Ongoing WMS via PUT /api/v1/returnOrders.
 * Dette varsler lageret om at en retur er på vei, slik at lagermedarbeider
 * finner den igjen i Ordre -> Returordreliste når varen kommer inn, og kan
 * ta mottak på den.
 */
export async function createReturnOrder(
  params: CreateReturnOrderParams
): Promise<CreateReturnOrderResult> {
  const body = {
    goodsOwnerId: env.ongoingGoodsOwnerId,
    returnOrderNumber: params.returnOrderNumber,
    customerOrder: {
      orderId: params.orderId,
    },
    comment: params.comment,
    warehouseId: env.ongoingWarehouseId,
    returnOrderLines: params.lines.map((line, index) => ({
      returnOrderRowNumber: String(index + 1),
      customerOrderLine: {
        orderLineId: line.orderLineId,
      },
      toBeReturnedNumberOfItems: line.quantity,
      returnCause: {
        code: params.reasonCode,
        name: params.reasonLabel,
      },
    })),
    tracking: params.trackingNumber
      ? [
          {
            waybill: params.trackingNumber,
            trackingUrl: params.trackingUrl,
          },
        ]
      : undefined,
  };

  let res: Response;
  try {
    res = await ongoingFetch("/returnOrders", {
      method: "PUT",
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      success: false,
      errorMessage: `Klarte ikke å kontakte Ongoing WMS: ${(err as Error).message}`,
    };
  }

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    return {
      success: false,
      errorMessage: json?.message || `Ongoing WMS avviste returordren (${res.status}).`,
    };
  }

  return {
    success: true,
    returnOrderId: json?.returnOrderId,
  };
}
