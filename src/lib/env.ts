// Sentral lesing av miljøvariabler, med tydelige feilmeldinger hvis noe mangler.
// Se .env.example for full liste og forklaring av hver variabel.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Miljøvariabelen ${name} mangler. Se .env.example / README.md for oppsett.`
    );
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const env = {
  // --- Ongoing WMS ---
  get ongoingWarehouse() {
    return required("ONGOING_WAREHOUSE");
  },
  get ongoingUsername() {
    return required("ONGOING_USERNAME");
  },
  get ongoingPassword() {
    return required("ONGOING_PASSWORD");
  },
  get ongoingGoodsOwnerId() {
    return Number(required("ONGOING_GOODS_OWNER_ID"));
  },
  get ongoingWarehouseId() {
    const v = optional("ONGOING_WAREHOUSE_ID");
    return v ? Number(v) : undefined;
  },
  get ongoingUseDemoServer() {
    return optional("ONGOING_USE_DEMO_SERVER") === "true";
  },

  // --- Webshipper ---
  get webshipperAccountName() {
    return required("WEBSHIPPER_ACCOUNT_NAME");
  },
  get webshipperAccessToken() {
    return required("WEBSHIPPER_ACCESS_TOKEN");
  },
  get webshipperCarrierId() {
    return required("WEBSHIPPER_CARRIER_ID");
  },
  get webshipperServiceCode() {
    return required("WEBSHIPPER_SERVICE_CODE");
  },

  // --- Standardmål brukt når en vare mangler vekt/mål i Ongoing (pakken må
  // ha enten volum eller mål for at Webshipper skal godta forsendelsen) ---
  get defaultItemWeightGrams() {
    const v = optional("WEBSHIPPER_DEFAULT_ITEM_WEIGHT_G");
    return v ? Number(v) : 500;
  },
  get defaultItemLengthCm() {
    const v = optional("WEBSHIPPER_DEFAULT_ITEM_LENGTH_CM");
    return v ? Number(v) : 30;
  },
  get defaultItemWidthCm() {
    const v = optional("WEBSHIPPER_DEFAULT_ITEM_WIDTH_CM");
    return v ? Number(v) : 20;
  },
  get defaultItemHeightCm() {
    const v = optional("WEBSHIPPER_DEFAULT_ITEM_HEIGHT_CM");
    return v ? Number(v) : 10;
  },

  // --- Varemottaker (lagerets) adresse - dit returen skal sendes ---
  get warehouseAddress() {
    return {
      name: required("WAREHOUSE_RETURN_NAME"),
      street: required("WAREHOUSE_RETURN_STREET"),
      postalCode: required("WAREHOUSE_RETURN_POSTAL_CODE"),
      city: required("WAREHOUSE_RETURN_CITY"),
      countryCode: optional("WAREHOUSE_RETURN_COUNTRY_CODE") || "NO",
    };
  },
};
