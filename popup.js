const PORTAL_URL = "https://mol.hostplus.com.au/";
const LOOKBACK_DAYS = 7;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGES = 25;
const CONTRIBUTION_GROUP_CODE = "*TFI";

const EXPLICIT_KIND_MAP = {
  "*TFI-MEMBER": "CONTRIBUTION",
  "*TFI-SPOUSE": "CONTRIBUTION",
  "*TFI-ROLLOVER": "CONTRIBUTION",
  "*FEE-ADMIN": "FEE",
};

const statusEl = document.getElementById("status");
const fromDateInput = document.getElementById("fromDate");
const toDateInput = document.getElementById("toDate");
const formatSelect = document.getElementById("exportFormat");

function setStatus(msg) {
  statusEl.textContent = msg;
}

// Visual display & query string format: YYYY-MM-DD
function formatIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Filename format: YYYYMMDD (no hyphens)
function isoToCompactYMD(isoDate) {
  return (isoDate || "").replaceAll("-", "");
}

function compactYMDToIso(ymd) {
  if (!/^\d{8}$/.test(ymd)) return "";
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function parseIsoDate(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function defaultFiveYearStartIso() {
  const fiveYearsAgoYear = new Date().getFullYear() - 5;
  return `${fiveYearsAgoYear}-01-01`;
}

function subtractDaysFromIso(isoDate, days) {
  const base = parseIsoDate(isoDate);
  if (!base) return defaultFiveYearStartIso();
  base.setDate(base.getDate() - days);
  return formatIsoDate(base);
}

function escapeCsvCell(value) {
  const str = value === null || value === undefined ? "" : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Computes paired timestamps where `earlierTimeStr` is 1 minute before `laterTimeStr`,
 * and keeps both on the same calendar day if the source timestamp is midnight (00:00:00).
 */
function computePairedTimestamps(rawDateStr) {
  const parsed = rawDateStr ? new Date(rawDateStr) : new Date();
  const baseDate = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

  const isMidnight =
    baseDate.getUTCHours() === 0 &&
    baseDate.getUTCMinutes() === 0 &&
    baseDate.getUTCSeconds() === 0 &&
    baseDate.getUTCMilliseconds() === 0;

  let earlierDate;
  let laterDate;

  if (isMidnight) {
    earlierDate = new Date(baseDate.getTime());
    laterDate = new Date(baseDate.getTime() + 60 * 1000);
  } else {
    earlierDate = new Date(baseDate.getTime() - 60 * 1000);
    laterDate = new Date(baseDate.getTime());
  }

  return {
    earlierTimeStr: earlierDate.toISOString(),
    laterTimeStr: laterDate.toISOString(),
  };
}

function resolveTransactionKind(item) {
  const txType = String(item.transactionType ?? "").trim();
  const groupCode = String(item.transactionGroupCode ?? "").trim();

  if (EXPLICIT_KIND_MAP[txType]) {
    return EXPLICIT_KIND_MAP[txType];
  }
  if (EXPLICIT_KIND_MAP[txType.toUpperCase()]) {
    return EXPLICIT_KIND_MAP[txType.toUpperCase()];
  }
  if (groupCode === CONTRIBUTION_GROUP_CODE || txType.toUpperCase().startsWith("*TFI")) {
    return "CONTRIBUTION";
  }
  return null;
}

function extractCashAmountAndCurrency(accounts, activeAllocations) {
  let accountCashTotal = 0;
  let detectedCurrency = null;

  for (const acct of accounts || []) {
    const rawAcctAmt = Number(acct.amount ?? 0);
    if (rawAcctAmt !== 0) {
      accountCashTotal += Math.abs(rawAcctAmt);
    }
    for (const opt of acct.investmentOptions || []) {
      if (!detectedCurrency && opt.nativeCurrency) {
        detectedCurrency = opt.nativeCurrency;
      }
    }
  }

  const allocationsAmountTotal = activeAllocations.reduce(
    (sum, alloc) => sum + (Math.abs(Number(alloc.amount)) || 0),
    0
  );

  const cashAmount = accountCashTotal > 0 ? accountCashTotal : allocationsAmountTotal;
  const currency =
    detectedCurrency ||
    activeAllocations.find((a) => a.currency)?.currency ||
    "AUD";

  return { cashAmount, currency };
}

function transformItemsToWealthfolioCsv(items, memberId) {
  const csvRows = [];
  const unhandledTypes = new Set();
  let contributionItemCount = 0;
  let buyRowCount = 0;
  let feeItemCount = 0;
  let sellRowCount = 0;

  for (const item of items || []) {
    const rawDate = item.date ?? "";
    const description = item.description ?? "";
    const transactionId = String(item.transactionId ?? "");
    const transactionType = String(item.transactionType ?? "");
    const groupCode = String(item.transactionGroupCode ?? "");
    const kind = resolveTransactionKind(item);

    if (!kind) {
      unhandledTypes.add(
        `type="${transactionType || "(empty)"}" group="${groupCode || "(empty)"}" [txId: ${transactionId || "unknown"}, desc: "${description}"]`
      );
      continue;
    }

    const accounts = Array.isArray(item.accounts) ? item.accounts : [];
    const activeAllocations = [];

    for (const acct of accounts) {
      const options = Array.isArray(acct.investmentOptions) ? acct.investmentOptions : [];
      for (const opt of options) {
        const symbol = String(opt.id ?? "").trim();
        const rawUnits = Number(opt.units ?? 0);
        const rawPrice = Number(opt.unitPrice ?? 0);
        const rawAmt = Number(opt.amount ?? 0);

        const absUnits = Math.abs(rawUnits);
        const absAmt = Math.abs(rawAmt);
        const absPrice = Math.abs(rawPrice);

        if (!symbol || (absUnits === 0 && absAmt === 0)) {
          continue;
        }

        const computedAmt = absAmt > 0 ? absAmt : absUnits * absPrice;
        activeAllocations.push({
          symbol,
          quantity: absUnits > 0 ? absUnits : "",
          unitPrice: absPrice > 0 ? absPrice : "",
          amount: computedAmt,
          currency: opt.nativeCurrency || "AUD",
        });
      }
    }

    const { cashAmount, currency } = extractCashAmountAndCurrency(accounts, activeAllocations);
    const { earlierTimeStr, laterTimeStr } = computePairedTimestamps(rawDate);
    const baseComment = `"${String(description).replace(/"/g, '\\"')}" ref:"${transactionId}"`;

    if (kind === "CONTRIBUTION") {
      contributionItemCount += 1;

      if (cashAmount > 0) {
        csvRows.push({
          date: earlierTimeStr,
          account: memberId,
          activityType: "DEPOSIT",
          symbol: "",
          quantity: "",
          unitPrice: "",
          amount: cashAmount,
          currency,
          comment: baseComment,
          transactionId,
          transactionType,
        });
      }

      for (const alloc of activeAllocations) {
        buyRowCount += 1;
        csvRows.push({
          date: laterTimeStr,
          account: memberId,
          activityType: "BUY",
          symbol: alloc.symbol,
          quantity: alloc.quantity,
          unitPrice: alloc.unitPrice,
          amount: alloc.amount,
          currency: alloc.currency,
          comment: baseComment,
          transactionId,
          transactionType,
        });
      }
    } else if (kind === "FEE") {
      feeItemCount += 1;

      // SELL first (earlierTimeStr) to generate cash, then FEE (laterTimeStr)
      for (const alloc of activeAllocations) {
        sellRowCount += 1;
        csvRows.push({
          date: earlierTimeStr,
          account: memberId,
          activityType: "SELL",
          symbol: alloc.symbol,
          quantity: alloc.quantity,
          unitPrice: alloc.unitPrice,
          amount: alloc.amount,
          currency: alloc.currency,
          comment: baseComment,
          transactionId,
          transactionType,
        });
      }

      if (cashAmount > 0) {
        csvRows.push({
          date: laterTimeStr,
          account: memberId,
          activityType: "FEE",
          symbol: "",
          quantity: "",
          unitPrice: "",
          amount: cashAmount,
          currency,
          comment: baseComment,
          transactionId,
          transactionType,
        });
      }
    }
  }

  const headers = [
    "date",
    "account",
    "activityType",
    "symbol",
    "quantity",
    "unitPrice",
    "amount",
    "currency",
    "comment",
    "transactionId",
    "transactionType",
  ];

  const lines = [
    headers.map(escapeCsvCell).join(","),
    ...csvRows.map((r) => headers.map((h) => escapeCsvCell(r[h])).join(",")),
  ];

  return {
    csv: lines.join("\n"),
    rowCount: csvRows.length,
    contributionItemCount,
    buyRowCount,
    feeItemCount,
    sellRowCount,
    unhandledTypes: Array.from(unhandledTypes),
  };
}

function downloadFile({ content, mimeType, filename }) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([content], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);

    chrome.downloads.download(
      {
        url: blobUrl,
        filename,
        saveAs: false,
      },
      (downloadId) => {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
        if (chrome.runtime.lastError || !downloadId) {
          reject(new Error(chrome.runtime.lastError?.message || "Unknown download error"));
          return;
        }
        resolve(downloadId);
      }
    );
  });
}

async function getCapturedRequest(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["sniffer.js"],
    });
  } catch {
    // Ignore if already injected at document_start
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => window.__HOSTPLUS_LAST_SEARCH_REQ__ || null,
  });

  return results?.[0]?.result || null;
}

async function initializePopup() {
  const todayIso = formatIsoDate(new Date());
  toDateInput.value = todayIso;

  const stored = await chrome.storage.local.get([
    "lastExportByMember",
    "preferredExportFormat",
    "lastSeenMemberId",
  ]);

  if (["both", "csv", "json"].includes(stored.preferredExportFormat)) {
    formatSelect.value = stored.preferredExportFormat;
  }

  const lastExportByMember = stored.lastExportByMember || {};
  let activeMemberId = stored.lastSeenMemberId || null;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    try {
      const captured = await getCapturedRequest(tab.id);
      if (captured?.memberId) {
        activeMemberId = captured.memberId;
      }
    } catch {
      // Tab may not match host permissions yet
    }
  }

  const rawLastExport = activeMemberId ? lastExportByMember[activeMemberId] : null;
  const lastExportIso = rawLastExport
    ? /^\d{8}$/.test(rawLastExport)
      ? compactYMDToIso(rawLastExport)
      : rawLastExport
    : null;

  const prefillFromIso = lastExportIso
    ? subtractDaysFromIso(lastExportIso, LOOKBACK_DAYS)
    : defaultFiveYearStartIso();

  fromDateInput.value = prefillFromIso;

  setStatus(
    `Member: ${activeMemberId || "pending sniff"}\n` +
      `Last export: ${lastExportIso || "none"}\n` +
      `From: ${prefillFromIso} | To: ${todayIso}`
  );
}

formatSelect.addEventListener("change", () => {
  chrome.storage.local.set({ preferredExportFormat: formatSelect.value });
});

document.getElementById("openHostplus").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { url: PORTAL_URL });
  } else {
    await chrome.tabs.create({ url: PORTAL_URL });
  }
  setStatus(`Opened ${PORTAL_URL}. Sign in with TOTP and open Transaction History.`);
});

document.getElementById("exportData").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus("No active tab found.");
    return;
  }

  const fromIso = fromDateInput.value;
  const toIso = toDateInput.value;
  const exportFormat = formatSelect.value;

  if (!parseIsoDate(fromIso) || !parseIsoDate(toIso)) {
    setStatus("Please select valid From and To dates.");
    return;
  }

  if (fromIso > toIso) {
    setStatus("From Date cannot be later than To Date.");
    return;
  }

  const captured = await getCapturedRequest(tab.id);
  if (!captured || !captured.url || !captured.memberId) {
    setStatus(
      "No Link Group /members/(memberId)/search request captured yet.\n" +
        "Open Transaction History on mol.hostplus.com.au (or refresh/change the date filter) and try again."
    );
    return;
  }

  const memberId = captured.memberId;
  setStatus(`Fetching member ${memberId} (${fromIso} to ${toIso})...`);

  let execResults;
  try {
    execResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      args: [captured, fromIso, toIso, DEFAULT_PAGE_SIZE, MAX_PAGES],
      func: async (reqMeta, fromDateStr, toDateStr, pageSize, maxPages) => {
        const baseUrl = new URL(reqMeta.url);
        baseUrl.searchParams.set("FromDate", fromDateStr);
        baseUrl.searchParams.set("ToDate", toDateStr);

        let offset = 1;

        const replayHeaders = {
          Accept: "application/json, text/plain, */*",
        };
        for (const [k, v] of Object.entries(reqMeta.headers || {})) {
          if (v !== undefined && v !== null && v !== "") {
            replayHeaders[k] = v;
          }
        }

        const seenIds = new Set();
        const mergedItems = [];
        let reportedTotalCount = null;
        let pageCount = 0;

        while (pageCount < maxPages) {
          const pageUrl = new URL(baseUrl.toString());
          pageUrl.searchParams.set("Size", String(pageSize));
          pageUrl.searchParams.set("Offset", String(offset));

          const res = await fetch(pageUrl.toString(), {
            method: reqMeta.method || "GET",
            credentials: "include",
            headers: replayHeaders,
          });

          if (!res.ok) {
            const bodyText = await res.text().catch(() => "");
            return { error: `HTTP ${res.status} on Offset=${offset}: ${bodyText}` };
          }

          const data = await res.json();
          pageCount += 1;

          if (typeof data.totalCount === "number") {
            reportedTotalCount = data.totalCount;
          }

          const items = Array.isArray(data.items) ? data.items : [];
          if (items.length === 0) {
            break;
          }

          let addedThisPage = 0;
          for (const item of items) {
            const key = item.transactionId ?? JSON.stringify(item);
            if (!seenIds.has(key)) {
              seenIds.add(key);
              mergedItems.push(item);
              addedThisPage += 1;
            }
          }

          if (
            addedThisPage === 0 ||
            (reportedTotalCount !== null && mergedItems.length >= reportedTotalCount)
          ) {
            break;
          }

          // Offset acts as a record index, so jump forward by the number of items returned
          offset += items.length;
        }

        return {
          payload: {
            items: mergedItems,
            totalCount: reportedTotalCount ?? mergedItems.length,
            fetchedPages: pageCount,
          },
        };
      },
    });
  } catch (err) {
    setStatus(`Script execution error: ${err.message}`);
    return;
  }

  const result = execResults?.[0]?.result;
  if (!result || result.error) {
    setStatus(result?.error || "Failed to fetch transaction history.");
    return;
  }

  const todayIso = formatIsoDate(new Date());
  const exportDateCompact = isoToCompactYMD(todayIso);
  const fromCompact = isoToCompactYMD(fromIso);
  const toCompact = isoToCompactYMD(toIso);
  const items = result.payload.items || [];
  const baseFilename = `${exportDateCompact}-Hostplus-${memberId}-transactions-${fromCompact}-${toCompact}`;

  const filesToDownload = [];
  let csvSummaryLines = "";

  if (exportFormat === "csv" || exportFormat === "both") {
    const transformed = transformItemsToWealthfolioCsv(items, memberId);
    filesToDownload.push({
      content: transformed.csv,
      mimeType: "text/csv;charset=utf-8",
      filename: `${baseFilename}.csv`,
    });
    csvSummaryLines =
      `\nCSV rows written: ${transformed.rowCount}` +
      `\nContribution items matched: ${transformed.contributionItemCount} (${transformed.buyRowCount} BUY row(s))` +
      `\nFee items matched: ${transformed.feeItemCount} (${transformed.sellRowCount} SELL row(s))`;

    if (transformed.unhandledTypes.length > 0) {
      csvSummaryLines +=
        `\n\nUnhandled transactionType(s) skipped (not mapped):\n- ` +
        transformed.unhandledTypes.join("\n- ");
    }
  }

  if (exportFormat === "json" || exportFormat === "both") {
    filesToDownload.push({
      content: JSON.stringify(result.payload, null, 2),
      mimeType: "application/json;charset=utf-8",
      filename: `${baseFilename}.json`,
    });
  }

  try {
    for (const fileSpec of filesToDownload) {
      await downloadFile(fileSpec);
    }
  } catch (err) {
    setStatus(`Download failed: ${err.message}`);
    return;
  }

  const stored = await chrome.storage.local.get(["lastExportByMember"]);
  const updatedMap = {
    ...(stored.lastExportByMember || {}),
    [memberId]: todayIso,
  };

  await chrome.storage.local.set({
    lastExportByMember: updatedMap,
    lastSeenMemberId: memberId,
    preferredExportFormat: exportFormat,
  });

  const savedNames = filesToDownload.map((f) => `- ${f.filename}`).join("\n");
  setStatus(
    `Saved:\n${savedNames}\n` +
      `Range: ${fromIso} to ${toIso}\n` +
      `Unique items: ${items.length} (${result.payload.fetchedPages} page(s))` +
      csvSummaryLines
  );
});

initializePopup();