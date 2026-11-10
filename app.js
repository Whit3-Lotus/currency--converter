"use strict";

const API_BASES = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies",
  "https://latest.currency-api.pages.dev/v1/currencies",
];
const CACHE_TTL_MS = 30 * 60 * 1000;
const DEBOUNCE_MS = 300;
const DEFAULT_PAIR = { from: "USD", to: "INR" };
const STORAGE_KEY = "currency-converter:pair";

const $ = (selector) => document.querySelector(selector);

const els = {
  form: $("#converter"),
  amount: $("#amount"),
  amountError: $("#amount-error"),
  from: $("#from"),
  to: $("#to"),
  flagFrom: $("#flag-from"),
  flagTo: $("#flag-to"),
  swap: $("#swap"),
  submit: $("#submit"),
  result: $("#result"),
  resultOk: $("#result-ok"),
  resultFrom: $("#result-from"),
  resultValue: $("#result-value"),
  resultCode: $("#result-code"),
  resultName: $("#result-name"),
  resultRate: $("#result-rate"),
  resultError: $("#result-error"),
  updated: $("#updated"),
};

class RateUnavailableError extends Error {
  constructor(from, to) {
    super(`No rate available for ${from} → ${to}`);
    this.name = "RateUnavailableError";
  }
}

const debounce = (fn, ms) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};

const currencyNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "currency" });
  } catch {
    return null;
  }
})();

const currencyName = (code) => {
  try {
    return currencyNames?.of(code) ?? code;
  } catch {
    return code;
  }
};

const formatPlain = (value) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value);

const formatResult = (value) => {
  if (value === 0) return "0";
  const options =
    Math.abs(value) >= 1
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : { maximumSignificantDigits: 4 };
  return new Intl.NumberFormat(undefined, options).format(value);
};

const formatRate = (value) =>
  new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 }).format(value);

const formatDate = (isoDate) => {
  const date = new Date(`${isoDate}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? isoDate
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
};

const parseAmount = (raw) => {
  const cleaned = raw.trim().replace(/[,\s]/g, "");
  if (cleaned === "") return { error: "Enter an amount to convert." };
  if (!/^(\d+\.?\d*|\.\d+)$/.test(cleaned)) {
    return { error: "Use numbers only, like 25 or 1,250.50." };
  }
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return { error: "That number is too large." };
  return { value };
};

const rateCache = new Map();

const requestRates = async (base) => {
  let lastError;
  for (const apiBase of API_BASES) {
    try {
      const response = await fetch(`${apiBase}/${base}.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const rates = data?.[base];
      if (!rates || typeof rates !== "object") {
        throw new Error("Unexpected API response");
      }
      return { rates, date: data.date ?? "" };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Request failed");
};

const getRates = (base, { force = false } = {}) => {
  const hit = rateCache.get(base);
  if (!force && hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return hit.promise;
  }
  const promise = requestRates(base);
  rateCache.set(base, { promise, fetchedAt: Date.now() });
  promise.catch(() => {
    if (rateCache.get(base)?.promise === promise) rateCache.delete(base);
  });
  return promise;
};

const populateSelects = () => {
  const codes = Object.keys(countryList).sort();
  for (const select of [els.from, els.to]) {
    select.replaceChildren(
      ...codes.map((code) => {
        const option = document.createElement("option");
        option.value = code;
        option.textContent = `${code} – ${currencyName(code)}`;
        return option;
      })
    );
  }
};

const updateFlag = (select, img) => {
  const countryCode = countryList[select.value];
  img.hidden = !countryCode;
  if (countryCode) {
    img.src = `https://flagsapi.com/${countryCode}/flat/64.png`;
  }
};

const syncFlags = () => {
  updateFlag(els.from, els.flagFrom);
  updateFlag(els.to, els.flagTo);
};

const setPair = (from, to) => {
  els.from.value = from;
  els.to.value = to;
  syncFlags();
};

const supportedCodes = (rates, base) => new Set([...Object.keys(rates), base]);

const pruneUnsupported = (supported) => {
  for (const select of [els.from, els.to]) {
    for (const option of [...select.options]) {
      if (!supported.has(option.value.toLowerCase())) option.remove();
    }
  }
};

const loadSavedPair = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved?.from in countryList && saved?.to in countryList) return saved;
  } catch {}
  return null;
};

const savePair = () => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ from: els.from.value, to: els.to.value })
    );
  } catch {}
};

let isLoading = false;

const setLoading = (loading) => {
  isLoading = loading;
  els.result.dataset.state = loading ? "loading" : "ready";
  els.form.setAttribute("aria-busy", String(loading));
  els.submit.setAttribute("aria-disabled", String(loading));
  els.submit.textContent = loading ? "Updating…" : "Get Exchange Rate";
};

const showAmountError = (message) => {
  els.amountError.hidden = !message;
  els.amountError.textContent = message ?? "";
  els.amount.setAttribute("aria-invalid", String(Boolean(message)));
};

const renderResult = ({ amount, from, to, rate, date }) => {
  els.resultError.hidden = true;
  els.resultOk.hidden = false;

  els.resultFrom.textContent = `${formatPlain(amount)} ${currencyName(from)} =`;
  els.resultValue.textContent = formatResult(amount * rate);
  els.resultCode.textContent = to;
  els.resultName.textContent = currencyName(to);
  els.resultRate.textContent =
    `1 ${from} = ${formatRate(rate)} ${to}  ·  ` +
    `1 ${to} = ${formatRate(1 / rate)} ${from}`;
  els.updated.textContent = date ? `Rates updated ${formatDate(date)}` : "";
};

const renderError = (error) => {
  els.resultOk.hidden = true;
  els.resultError.hidden = false;
  els.resultError.textContent =
    error instanceof RateUnavailableError
      ? "Rates for this currency pair aren't available right now. Try a different pair."
      : "Couldn't load the exchange rate. Check your connection, then press “Get Exchange Rate” to try again.";
  els.updated.textContent = "";
};

let latestRequest = 0;

const convert = async ({ force = false } = {}) => {
  const parsed = parseAmount(els.amount.value);
  if ("error" in parsed) {
    showAmountError(parsed.error);
    return;
  }
  showAmountError(null);

  const from = els.from.value;
  const to = els.to.value;
  const requestId = ++latestRequest;
  setLoading(true);

  try {
    const { rates, date } = await getRates(from.toLowerCase(), { force });
    if (requestId !== latestRequest) return;

    const rate = rates[to.toLowerCase()];
    if (typeof rate !== "number" || !(rate > 0)) {
      throw new RateUnavailableError(from, to);
    }
    renderResult({ amount: parsed.value, from, to, rate, date });
  } catch (error) {
    if (requestId !== latestRequest) return;
    console.error("Conversion failed:", error);
    renderError(error);
  } finally {
    if (requestId === latestRequest) setLoading(false);
  }
};

const convertSoon = debounce(() => convert(), DEBOUNCE_MS);

const bindEvents = () => {
  els.amount.addEventListener("input", convertSoon);

  for (const [select, img] of [
    [els.from, els.flagFrom],
    [els.to, els.flagTo],
  ]) {
    select.addEventListener("change", () => {
      updateFlag(select, img);
      savePair();
      convert();
    });
    img.addEventListener("error", () => (img.hidden = true));
    img.addEventListener("load", () => (img.hidden = false));
  }

  els.swap.addEventListener("click", () => {
    setPair(els.to.value, els.from.value);
    els.swap.dataset.flipped = String(els.swap.dataset.flipped !== "true");
    savePair();
    convert();
  });

  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (isLoading) return;
    convert({ force: true });
  });
};

const init = async () => {
  populateSelects();
  const pair = loadSavedPair() ?? DEFAULT_PAIR;
  setPair(pair.from, pair.to);
  bindEvents();

  try {
    const { rates } = await getRates("usd");
    const supported = supportedCodes(rates, "usd");
    pruneUnsupported(supported);
    const has = (code) => supported.has(code.toLowerCase());
    setPair(
      has(pair.from) ? pair.from : DEFAULT_PAIR.from,
      has(pair.to) ? pair.to : DEFAULT_PAIR.to
    );
  } catch {}

  await convert();
};

init();
