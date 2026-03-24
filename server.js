const express = require("express");
const fetch = require("node-fetch");
const { URL } = require("url");
const path = require("path");
const zlib = require("zlib");

const app = express();
const PORT = process.env.PORT || 3000;

// Parse bodies
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));

// In-memory LRU cache for speed
class LRUCache {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }
  get(key) {
    if (!this.cache.has(key)) return null;
    const val = this.cache.get(key);
    // Refresh position
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }
  set(key, value, ttl = 300000) {
    if (this.cache.size >= this.maxSize) {
      // Delete oldest
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, expires: Date.now() + ttl });
  }
}

const cache = new LRUCache(200);

// Validate and normalize URL
function normalizeUrl(input) {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }
  // Validate it's a proper URL
  const parsed = new URL(url);
  // Block local/private IPs to prevent SSRF
  const hostname = parsed.hostname;
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("172.16.") ||
    hostname === "::1"
  ) {
    throw new Error("Access to local addresses is not allowed");
  }
  return parsed.href;
}

// Rewrite URLs in HTML so links go through the proxy
function rewriteHtml(html, baseUrl) {
  const base = new URL(baseUrl);

  // Rewrite src, href, action attributes to go through proxy
  html = html.replace(
    /(src|href|action)\s*=\s*["'](?!data:|javascript:|mailto:|#|blob:)([^"']+)["']/gi,
    (match, attr, url) => {
      try {
        const absolute = new URL(url, baseUrl).href;
        return `${attr}="/proxy?url=${encodeURIComponent(absolute)}"`;
      } catch {
        return match;
      }
    }
  );

  // Rewrite CSS url() references
  html = html.replace(
    /url\(\s*["']?(?!data:)([^"')]+)["']?\s*\)/gi,
    (match, url) => {
      try {
        const absolute = new URL(url, baseUrl).href;
        return `url("/proxy?url=${encodeURIComponent(absolute)}")`;
      } catch {
        return match;
      }
    }
  );

  // Inject base tag for relative resources
  if (!html.includes("<base")) {
    html = html.replace(
      /<head([^>]*)>/i,
      `<head$1><base href="/proxy?url=${encodeURIComponent(base.origin)}/">`
    );
  }

  return html;
}

// Rewrite URLs in CSS
function rewriteCss(css, baseUrl) {
  return css.replace(
    /url\(\s*["']?(?!data:)([^"')]+)["']?\s*\)/gi,
    (match, url) => {
      try {
        const absolute = new URL(url, baseUrl).href;
        return `url("/proxy?url=${encodeURIComponent(absolute)}")`;
      } catch {
        return match;
      }
    }
  );
}

// Main proxy endpoint
app.get("/proxy", async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  let url;
  try {
    url = normalizeUrl(targetUrl);
  } catch (err) {
    return res.status(400).json({ error: "Invalid URL: " + err.message });
  }

  // Check cache
  const cached = cache.get(url);
  if (cached && Date.now() < cached.expires) {
    const { contentType, body } = cached.value;
    res.set("Content-Type", contentType);
    res.set("X-Proxy-Cache", "HIT");
    return res.send(body);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        Referer: url,
      },
      redirect: "follow",
      compress: true,
    });

    clearTimeout(timeout);

    const contentType = response.headers.get("content-type") || "";
    const buffer = await response.buffer();

    let body;

    if (contentType.includes("text/html")) {
      body = buffer.toString("utf-8");
      body = rewriteHtml(body, url);
      // Inject proxy navigation bar
      body = body.replace(
        /<body([^>]*)>/i,
        `<body$1>
        <div id="proxy-bar" style="position:fixed;top:0;left:0;right:0;z-index:999999;background:#1a1a2e;padding:8px 12px;display:flex;align-items:center;gap:8px;font-family:-apple-system,system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.3);">
          <a href="/" style="color:#e94560;font-weight:700;text-decoration:none;font-size:14px;">⚡ Proxy</a>
          <input id="proxy-url" type="text" value="${url}" style="flex:1;padding:6px 10px;border-radius:6px;border:1px solid #333;background:#16213e;color:#eee;font-size:14px;outline:none;" />
          <button onclick="window.location='/proxy?url='+encodeURIComponent(document.getElementById('proxy-url').value)" style="padding:6px 14px;border-radius:6px;border:none;background:#e94560;color:#fff;font-weight:600;font-size:14px;cursor:pointer;">Go</button>
        </div>
        <div style="height:48px;"></div>`
      );
      res.set("Content-Type", "text/html; charset=utf-8");
    } else if (contentType.includes("text/css")) {
      body = rewriteCss(buffer.toString("utf-8"), url);
      res.set("Content-Type", contentType);
    } else {
      body = buffer;
      res.set("Content-Type", contentType);
    }

    // Cache non-HTML resources longer
    const ttl = contentType.includes("text/html") ? 60000 : 300000;
    cache.set(url, { contentType: res.get("Content-Type"), body }, ttl);

    res.set("X-Proxy-Cache", "MISS");
    res.send(body);
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "Request timed out" });
    }
    console.error("Proxy error:", err.message);
    res.status(502).json({ error: "Failed to fetch: " + err.message });
  }
});

// POST proxy for forms
app.post("/proxy", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  let url;
  try {
    url = normalizeUrl(targetUrl);
  } catch (err) {
    return res.status(400).json({ error: "Invalid URL: " + err.message });
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": req.get("content-type") || "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      },
      body: JSON.stringify(req.body),
      redirect: "follow",
      compress: true,
    });

    const contentType = response.headers.get("content-type") || "";
    const buffer = await response.buffer();

    if (contentType.includes("text/html")) {
      let html = buffer.toString("utf-8");
      html = rewriteHtml(html, url);
      res.set("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } else {
      res.set("Content-Type", contentType);
      res.send(buffer);
    }
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch: " + err.message });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), cacheSize: cache.cache.size });
});

app.listen(PORT, () => {
  console.log(`⚡ Web Proxy running on http://localhost:${PORT}`);
});
