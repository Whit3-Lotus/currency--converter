"use strict";

const API_BASES = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies",
  "https://latest.currency-api.pages.dev/v1/currencies",
];
const CACHE_TTL_MS = 30 * 60 * 1000; // rates younger than this are used as-is
const FETCH_TIMEOUT_MS = 6000; // give up on a slow request instead of hanging
const DEBOUNCE_MS = 300;
const DEFAULT_PAIR = { from: "USD", to: "INR" };
const STORAGE_KEY = "currency-converter:pair";
const RATES_KEY_PREFIX = "currency-converter:rates:";
const FLAG_URL = (countryCode, width) =>
  `https://flagcdn.com/w${width}/${countryCode.toLowerCase()}.png`;

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

/* ---------------------------------------------------------------------------
 * Rates: memory cache -> localStorage cache -> network
 *
 * - Both API hosts are requested at the SAME time; the first good answer wins
 *   (before, the second host was only tried after the first one failed).
 * - Every request has a timeout so a slow host can't hang the page.
 * - Rates are saved in localStorage, so repeat visits show a result instantly
 *   and refresh quietly in the background (stale-while-revalidate).
 * ------------------------------------------------------------------------- */

const memoryCache = new Map(); // base -> { rates, date, fetchedAt }
const inflight = new Map(); // base -> Promise

const readStored = (base) => {
  try {
    const entry = JSON.parse(localStorage.getItem(RATES_KEY_PREFIX + base) ?? "null");
    if (entry?.rates && typeof entry.fetchedAt === "number") return entry;
  } catch {}
  return null;
};

const writeStored = (base, entry) => {
  try {
    localStorage.setItem(RATES_KEY_PREFIX + base, JSON.stringify(entry));
  } catch {}
};

const peekRates = (base) => {
  let entry = memoryCache.get(base) ?? null;
  if (!entry) {
    entry = readStored(base);
    if (entry) memoryCache.set(base, entry);
  }
  return entry;
};

const isFresh = (entry) => Date.now() - entry.fetchedAt < CACHE_TTL_MS;

const requestRates = async (base) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await Promise.any(
      API_BASES.map(async (apiBase) => {
        const response = await fetch(`${apiBase}/${base}.json`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const rates = data?.[base];
        if (!rates || typeof rates !== "object") {
          throw new Error("Unexpected API response");
        }
        return { rates, date: data.date ?? "" };
      })
    );
  } catch (error) {
    throw error instanceof AggregateError ? error.errors[0] : error;
  } finally {
    clearTimeout(timer);
    controller.abort(); // cancel whichever request lost the race
  }
};

const fetchFreshRates = (base) => {
  const pending = inflight.get(base);
  if (pending) return pending;

  const promise = requestRates(base)
    .then((data) => {
      const entry = { ...data, fetchedAt: Date.now() };
      memoryCache.set(base, entry);
      writeStored(base, entry);
      return entry;
    })
    .finally(() => inflight.delete(base));

  inflight.set(base, promise);
  return promise;
};

/* --------------------------------- UI ------------------------------------ */

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
  if (!countryCode) {
    img.hidden = true;
    return;
  }
  const src = FLAG_URL(countryCode, 40);
  if (img.getAttribute("src") === src) return;
  img.hidden = false;
  img.srcset = `${FLAG_URL(countryCode, 80)} 2x`;
  img.src = src;
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

// Remove currencies the API doesn't know about. Runs once, using whichever
// rates arrive first, so no extra request is needed. Returns true when the
// current selection had to change.
let pruned = false;
const pruneOnce = (rates, base) => {
  if (pruned) return false;
  pruned = true;

  const supported = supportedCodes(rates, base);
  const { value: from } = els.from;
  const { value: to } = els.to;
  pruneUnsupported(supported);

  const has = (code) => supported.has(code.toLowerCase());
  if (has(from) && has(to)) return false;

  setPair(
    has(from) ? from : DEFAULT_PAIR.from,
    has(to) ? to : DEFAULT_PAIR.to
  );
  return true;
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

// "loading" shows the skeleton in the result box; it is only used when there
// is nothing (not even saved rates) to show yet.
const setLoading = (loading) => {
  isLoading = loading;
  els.result.dataset.state = loading ? "loading" : "ready";
  els.form.setAttribute("aria-busy", String(loading));
  els.submit.setAttribute("aria-disabled", String(loading));
  els.submit.textContent = loading ? "Updating…" : "Get Exchange Rate";
  if (loading) els.resultError.hidden = true;
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
  const base = from.toLowerCase();
  const requestId = ++latestRequest;

  // Saved rates (even slightly old ones) are shown immediately.
  const cached = force ? null : peekRates(base);
  setLoading(!cached);

  // Returns false when the selection changed and a new conversion was started.
  const present = (entry) => {
    if (pruneOnce(entry.rates, base)) {
      convert();
      return false;
    }
    const rate = entry.rates[to.toLowerCase()];
    if (typeof rate !== "number" || !(rate > 0)) {
      throw new RateUnavailableError(from, to);
    }
    renderResult({ amount: parsed.value, from, to, rate, date: entry.date });
    return true;
  };

  try {
    if (cached) {
      if (!present(cached)) return;
      if (isFresh(cached)) return;
    }

    const fresh = await fetchFreshRates(base); // refresh in the background
    if (requestId !== latestRequest) return;
    present(fresh);
  } catch (error) {
    if (requestId !== latestRequest) return;
    console.error("Conversion failed:", error);
    if (cached && !(error instanceof RateUnavailableError)) {
      // Network failed but we already showed saved rates: keep them.
      els.updated.textContent += " (offline – showing saved rates)";
      return;
    }
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

const init = () => {
  populateSelects();
  const pair = loadSavedPair() ?? DEFAULT_PAIR;
  setPair(pair.from, pair.to);
  bindEvents();
  convert(); // single request path: no separate "prune" fetch any more
};

init();
