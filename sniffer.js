(() => {
  if (window.__HOSTPLUS_SNIFFER_INSTALLED__) return;
  window.__HOSTPLUS_SNIFFER_INSTALLED__ = true;
  window.__HOSTPLUS_LAST_SEARCH_REQ__ = window.__HOSTPLUS_LAST_SEARCH_REQ__ || null;

  const MEMBER_SEARCH_REGEX = /linkgroup\.[^/]+\/.*\/members\/([^/?#]+)\/search(?:\?|$)/i;

  function parseMemberSearchUrl(url) {
    if (typeof url !== "string") return null;
    const match = MEMBER_SEARCH_REGEX.exec(url);
    if (!match) return null;
    return {
      memberId: decodeURIComponent(match[1]),
      url,
    };
  }

  function normalizeHeaders(headersInit) {
    const out = {};
    if (!headersInit) return out;
    if (headersInit instanceof Headers) {
      headersInit.forEach((v, k) => {
        out[k] = v;
      });
    } else if (Array.isArray(headersInit)) {
      for (const [k, v] of headersInit) {
        out[k] = v;
      }
    } else if (typeof headersInit === "object") {
      Object.assign(out, headersInit);
    }
    return out;
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init = {}) {
    const url = typeof input === "string" ? input : input?.url || "";
    const parsed = parseMemberSearchUrl(url);
    if (parsed) {
      const reqHeaders = normalizeHeaders(init.headers);
      if (typeof input === "object" && input?.headers) {
        Object.assign(reqHeaders, normalizeHeaders(input.headers));
      }
      window.__HOSTPLUS_LAST_SEARCH_REQ__ = {
        url: parsed.url,
        memberId: parsed.memberId,
        method: init.method || input?.method || "GET",
        headers: reqHeaders,
        capturedAt: Date.now(),
      };
    }
    return origFetch.apply(this, arguments);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__hpUrl = url;
    this.__hpMethod = method;
    this.__hpHeaders = {};
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__hpHeaders) {
      this.__hpHeaders[name] = value;
    }
    return origSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const parsed = parseMemberSearchUrl(this.__hpUrl);
    if (parsed) {
      window.__HOSTPLUS_LAST_SEARCH_REQ__ = {
        url: parsed.url,
        memberId: parsed.memberId,
        method: this.__hpMethod || "GET",
        headers: { ...(this.__hpHeaders || {}) },
        capturedAt: Date.now(),
      };
    }
    return origSend.apply(this, arguments);
  };
})();