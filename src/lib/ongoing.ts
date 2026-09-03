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

interface OngoingOrderConsignee {
  name?: string;
  emailAddress?: string;
}

interface OngoingOrderInfo {
  orderId: number;
  orderNumber?: string;
}

interface OngoingOrderModel {
  orderInfo?: OngoingOrderInfo | null;
  consignee?: OngoingOrderConsignee | null;
  orderLines?: OngoingOrderLine[] | null;
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

  const lines: OrderLineForCustomer[] = (order.orderLines || []).map((line) => ({
    orderLineId: line.id,
    rowNumber: line.rowNumber || String(line.id),
    articleNumber: line.article?.articleNumber || "",
    articleName: line.article?.articleName || line.article?.articleNumber || "Ukjent vare",
    orderedNumberOfItems: line.orderedNumberOfItems,
    alreadyReturnedNumberOfItems: line.returnedNumberOfItems || 0,
  }));

  return {
    found: true,
    orderId: order.orderInfo.orderId,
    orderNumber: order.orderInfo.orderNumber || orderNumber,
    customerName: order.consignee?.name || "",
    customerEmail: order.consignee?.emailAddress || null,
    lines,
  };
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
