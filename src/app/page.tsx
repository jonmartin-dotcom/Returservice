"use client";

import { useState } from "react";
import styles from "./page.module.css";
import {
  RETURN_REASONS,
  type OrderLookupResponse,
  type OrderLineForCustomer,
  type ReturnReasonCode,
  type ReturnRequestResult,
  type DeliveryMethod,
} from "@/lib/types";

type Step = 1 | 2 | 3 | 4;

interface SelectedLine {
  line: OrderLineForCustomer;
  quantity: number;
  selected: boolean;
}

export default function Home() {
  const [step, setStep] = useState<Step>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Steg 1
  const [orderNumber, setOrderNumber] = useState("");
  const [order, setOrder] = useState<OrderLookupResponse | null>(null);

  // Steg 2
  const [selectedLines, setSelectedLines] = useState<SelectedLine[]>([]);
  const [reasonCode, setReasonCode] = useState<ReturnReasonCode>("ANGRER_KJOP");
  const [message, setMessage] = useState("");

  // Steg 3
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [street, setStreet] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [city, setCity] = useState("");
  const [countryCode, setCountryCode] = useState("NO");

  // Steg 4 (resultat)
  const [result, setResult] = useState<ReturnRequestResult | null>(null);

  async function handleLookupOrder(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/order/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNumber }),
      });
      const data: OrderLookupResponse = await res.json();

      if (!data.found) {
        setError(
          data.reason === "NOT_FOUND"
            ? "Fant ingen ordre med dette ordrenummeret. Sjekk at du har skrevet det riktig."
            : "Noe gikk galt. Vennligst prøv igjen."
        );
        setLoading(false);
        return;
      }

      setOrder(data);
      setSelectedLines(
        data.lines.map((line) => ({
          line,
          quantity: Math.max(0, line.orderedNumberOfItems - line.alreadyReturnedNumberOfItems),
          selected: false,
        }))
      );
      setFirstName(data.customerName.split(" ")[0] || "");
      setLastName(data.customerName.split(" ").slice(1).join(" ") || "");
      setEmail(data.customerEmail || "");
      setPhone(data.customerPhone || "");
      setStreet(data.customerStreet || "");
      setPostalCode(data.customerPostalCode || "");
      setCity(data.customerCity || "");
      setCountryCode(data.customerCountryCode || "NO");
      setStep(2);
    } catch {
      setError("Klarte ikke å kontakte serveren. Sjekk internettforbindelsen og prøv igjen.");
    } finally {
      setLoading(false);
    }
  }

  function handleContinueFromLines(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const anySelected = selectedLines.some((l) => l.selected && l.quantity > 0);
    if (!anySelected) {
      setError("Velg minst én vare du vil returnere.");
      return;
    }
    setStep(3);
  }

  async function handleSubmitReturn(deliveryMethod: DeliveryMethod) {
    setError(null);

    if (!firstName || !lastName || !phone || !email || !street || !postalCode || !city) {
      setError("Fyll ut alle feltene under.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/return", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderNumber,
          firstName,
          lastName,
          phone,
          email,
          reasonCode,
          message,
          lines: selectedLines
            .filter((l) => l.selected && l.quantity > 0)
            .map((l) => ({
              orderLineId: l.line.orderLineId,
              articleNumber: l.line.articleNumber,
              quantity: l.quantity,
            })),
          address: { street, postalCode, city, countryCode },
          deliveryMethod,
        }),
      });
      const data: ReturnRequestResult = await res.json();

      if (!data.success) {
        setError(data.error || "Noe gikk galt. Vennligst prøv igjen.");
        setLoading(false);
        return;
      }

      setResult(data);
      setStep(4);
    } catch {
      setError("Klarte ikke å kontakte serveren. Sjekk internettforbindelsen og prøv igjen.");
    } finally {
      setLoading(false);
    }
  }

  function updateLineSelected(index: number, selected: boolean) {
    setSelectedLines((prev) =>
      prev.map((l, i) => (i === index ? { ...l, selected } : l))
    );
  }

  function updateLineQuantity(index: number, quantity: number) {
    setSelectedLines((prev) =>
      prev.map((l, i) => (i === index ? { ...l, quantity } : l))
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <span className={styles.logo}>Nesco</span>
        <span className={styles.tagline}>Returservice</span>
      </div>

      <div className={styles.card}>
        <div className={styles.steps}>
          {[1, 2, 3, 4].map((s) => (
            <div key={s} className={`${styles.step} ${step >= s ? styles.stepActive : ""}`} />
          ))}
        </div>

        {error && <div className={styles.errorBox}>{error}</div>}

        {step === 1 && (
          <form onSubmit={handleLookupOrder}>
            <h1 className={styles.title}>Start en retur</h1>
            <p className={styles.subtitle}>
              Skriv inn ordrenummeret du fikk på kvitteringen eller i e-posten fra Nesco.
            </p>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="orderNumber">
                Ordrenummer
              </label>
              <input
                id="orderNumber"
                className={styles.input}
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                placeholder="f.eks. test1"
                required
              />
            </div>
            <button className={styles.button} type="submit" disabled={loading}>
              {loading ? "Søker…" : "Finn ordre"}
            </button>
          </form>
        )}

        {step === 2 && order?.found && (
          <form onSubmit={handleContinueFromLines}>
            <h1 className={styles.title}>Velg varer du vil returnere</h1>
            <p className={styles.subtitle}>Ordre {order.orderNumber}</p>

            {selectedLines.map((item, index) => (
              <div key={item.line.orderLineId} className={styles.lineItem}>
                <input
                  type="checkbox"
                  checked={item.selected}
                  onChange={(e) => updateLineSelected(index, e.target.checked)}
                />
                <div className={styles.lineInfo}>
                  <div className={styles.lineName}>{item.line.articleName}</div>
                  <div className={styles.lineMeta}>
                    Bestilt: {item.line.orderedNumberOfItems} stk
                  </div>
                </div>
                <input
                  type="number"
                  className={styles.qtyInput}
                  min={0}
                  max={item.line.orderedNumberOfItems - item.line.alreadyReturnedNumberOfItems}
                  value={item.quantity}
                  disabled={!item.selected}
                  onChange={(e) => updateLineQuantity(index, Number(e.target.value))}
                />
              </div>
            ))}

            <div className={styles.field} style={{ marginTop: 20 }}>
              <label className={styles.label} htmlFor="reasonCode">
                Årsak til retur
              </label>
              <select
                id="reasonCode"
                className={styles.select}
                value={reasonCode}
                onChange={(e) => setReasonCode(e.target.value as ReturnReasonCode)}
              >
                {RETURN_REASONS.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="message">
                Kommentar (valgfritt)
              </label>
              <textarea
                id="message"
                className={styles.textarea}
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>

            <div className={styles.buttonRow}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setStep(1)}
              >
                Tilbake
              </button>
              <button className={styles.button} type="submit">
                Fortsett
              </button>
            </div>
          </form>
        )}

        {step === 3 && (
          <div>
            <h1 className={styles.title}>Dine kontaktopplysninger</h1>
            <p className={styles.subtitle}>
              Vi bruker denne informasjonen til å lage returetiketten eller QR-koden din.
            </p>

            <div className={styles.row}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="firstName">
                  Fornavn
                </label>
                <input
                  id="firstName"
                  className={styles.input}
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  required
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="lastName">
                  Etternavn
                </label>
                <input
                  id="lastName"
                  className={styles.input}
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className={styles.row}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="phone">
                  Mobilnummer
                </label>
                <input
                  id="phone"
                  className={styles.input}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="email">
                  E-post
                </label>
                <input
                  id="email"
                  type="email"
                  className={styles.input}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="street">
                Gateadresse
              </label>
              <input
                id="street"
                className={styles.input}
                value={street}
                onChange={(e) => setStreet(e.target.value)}
                required
              />
            </div>

            <div className={styles.row}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="postalCode">
                  Postnummer
                </label>
                <input
                  id="postalCode"
                  className={styles.input}
                  value={postalCode}
                  onChange={(e) => setPostalCode(e.target.value)}
                  required
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="city">
                  Poststed
                </label>
                <input
                  id="city"
                  className={styles.input}
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  required
                />
              </div>
            </div>

            <p className={styles.label} style={{ marginBottom: 10 }}>
              Hvordan vil du motta returen?
            </p>

            <div className={styles.buttonRow}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => handleSubmitReturn("LABEL")}
                disabled={loading}
              >
                {loading ? "Sender…" : "Last ned etikett"}
              </button>
              <button
                type="button"
                className={styles.button}
                onClick={() => handleSubmitReturn("QR")}
                disabled={loading}
              >
                {loading ? "Sender…" : "Send QR-kode (SMS og e-post)"}
              </button>
            </div>

            <div className={styles.buttonRow} style={{ marginTop: 8 }}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setStep(2)}
                disabled={loading}
              >
                Tilbake
              </button>
            </div>
          </div>
        )}

        {step === 4 && result?.success && (
          <div>
            <h1 className={styles.title}>Returen er registrert!</h1>
            <div className={styles.successBox}>
              Returordre {result.returnOrderNumber} er registrert hos oss.
              {result.trackingNumber && (
                <>
                  <br />
                  Sporingsnummer: {result.trackingNumber}
                </>
              )}
            </div>

            {result.warning && <div className={styles.warningBox}>{result.warning}</div>}

            {result.deliveryMethod === "QR" ? (
              <div className={styles.successBox}>
                QR-koden er sendt til deg på SMS og e-post fra Bring. Vis den i
                utleveringsappen eller på skjermen din når du leverer pakken hos et
                Bring-utleveringssted.
              </div>
            ) : (
              <>
                {result.labelPdfBase64 && (
                  <a
                    className={styles.downloadLink}
                    href={`data:application/pdf;base64,${result.labelPdfBase64}`}
                    download={`returetikett-${result.returnOrderNumber}.pdf`}
                  >
                    Last ned returetikett (PDF)
                  </a>
                )}
                {!result.labelPdfBase64 && result.labelUrl && (
                  <a
                    className={styles.downloadLink}
                    href={result.labelUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Åpne returetikett
                  </a>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div className={styles.footer}>Nesco – returservice</div>
    </div>
  );
}
