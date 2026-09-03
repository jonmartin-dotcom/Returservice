// Delte typer for returservice-løsningen.

export type ReturnReasonCode = "ANGRER_KJOP" | "BYTTE" | "REKLAMASJON";

export interface ReturnReasonOption {
  code: ReturnReasonCode;
  label: string;
}

export const RETURN_REASONS: ReturnReasonOption[] = [
  { code: "ANGRER_KJOP", label: "Angrer kjøp" },
  { code: "BYTTE", label: "Bytte" },
  { code: "REKLAMASJON", label: "Reklamasjon" },
];

// Én ordrelinje slik den vises til kunden for utvalg av hva som skal returneres.
export interface OrderLineForCustomer {
  orderLineId: number;
  rowNumber: string;
  articleNumber: string;
  articleName: string;
  orderedNumberOfItems: number;
  /** Hvor mange enheter som allerede er registrert returnert tidligere. */
  alreadyReturnedNumberOfItems: number;
}

export interface OrderLookupResult {
  found: true;
  orderId: number;
  orderNumber: string;
  customerName: string;
  customerEmail: string | null;
  /** Mottakerinfo fra den opprinnelige ordren i Ongoing - brukes til å
   *  forhåndsutfylle kontaktfeltene i steg 3, som kunden fortsatt kan endre. */
  customerPhone: string | null;
  customerStreet: string | null;
  customerPostalCode: string | null;
  customerCity: string | null;
  customerCountryCode: string | null;
  lines: OrderLineForCustomer[];
}

export interface OrderLookupNotFound {
  found: false;
  reason: "NOT_FOUND" | "ERROR";
  message: string;
}

export type OrderLookupResponse = OrderLookupResult | OrderLookupNotFound;

// Én linje kunden faktisk ønsker å returnere, med antall.
export interface ReturnLineSelection {
  orderLineId: number;
  articleNumber: string;
  quantity: number;
}

export interface ReturnRequest {
  orderNumber: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  reasonCode: ReturnReasonCode;
  message: string;
  lines: ReturnLineSelection[];
  /** Kundens adresse - trengs av fraktleverandøren for å hente/generere returetiketten. */
  address: {
    street: string;
    postalCode: string;
    city: string;
    countryCode: string; // f.eks. "NO"
  };
}

export interface ReturnRequestResult {
  success: boolean;
  returnOrderId?: number;
  returnOrderNumber?: string;
  trackingNumber?: string;
  labelPdfBase64?: string;
  labelUrl?: string;
  error?: string;
  /** Ikke-kritisk advarsel som fortsatt lar returen regnes som vellykket, f.eks. at
   *  etiketten ikke kunne hentes automatisk selv om forsendelsen ble opprettet. */
  warning?: string;
}
