'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MAX_BODY = 1024 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const CSP = "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'";

// Assets are read once at startup, so a plugin update deleting this version's
// cache folder cannot break a running server.
function loadAssets(dir, prefix = '/') {
  const assets = new Map();
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      for (const [k, v] of loadAssets(path.join(dir, e.name), `${prefix}${e.name}/`)) assets.set(k, v);
    } else {
      const type = TYPES[path.extname(e.name)];
      if (type) assets.set(prefix + e.name, { type, body: fs.readFileSync(path.join(dir, e.name)) });
    }
  }
  return assets;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, value) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function createHandler(app, { hookToken, viewerToken }, webDir) {
  const assets = loadAssets(webDir);

  return function handleSafely(req, res) {
    handle(req, res).catch((err) => {
      console.error('request', err);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    });
  };

  async function handle(req, res) {
    const { port } = req.socket.address();
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    // Blocks DNS rebinding and cross-site requests from other web pages.
    if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: 'bad host' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'bad origin' });

    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host}`);
    } catch {
      return json(res, 400, { error: 'bad path' });
    }
    const route = `${req.method} ${url.pathname}`;
    const isHookClient = req.headers.authorization === `Bearer ${hookToken}`;
    const isViewer = url.searchParams.get('t') === viewerToken;

    if (route === 'POST /hook') {
      if (!isHookClient) return json(res, 401, { error: 'unauthorized' });
      try {
        const { hookAt, msg } = JSON.parse(await readBody(req));
        json(res, 200, {});
        await app.onHook(msg, hookAt);
      } catch (err) {
        if (!res.headersSent) json(res, 400, { error: 'bad request' });
        console.error('hook', err);
      }
      return undefined;
    }
    if (route === 'GET /health') {
      if (!isHookClient) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, app.health());
    }
    if (route === 'POST /shutdown') {
      if (!isHookClient) return json(res, 401, { error: 'unauthorized' });
      json(res, 200, {});
      return app.shutdown();
    }

    if (url.pathname.startsWith('/api/')) {
      if (!isViewer) return json(res, 401, { error: 'unauthorized' });
      if (route === 'GET /api/events') return app.addClient(req, res);
      if (route === 'GET /api/file') {
        const detail = app.fileDetail(url.searchParams.get('id'));
        return detail ? json(res, 200, detail) : json(res, 404, { error: 'unknown node' });
      }
      if (route === 'POST /api/heat/reset') {
        app.resetHeat();
        return json(res, 200, {});
      }
      return json(res, 404, { error: 'not found' });
    }

    if (req.method === 'GET') {
      const asset = assets.get(url.pathname === '/' ? '/index.html' : url.pathname);
      if (asset) {
        const headers = { 'content-type': asset.type, 'cache-control': 'no-cache', 'referrer-policy': 'no-referrer' };
        if (url.pathname === '/') headers['content-security-policy'] = CSP;
        res.writeHead(200, headers);
        return res.end(asset.body);
      }
    }
    return json(res, 404, { error: 'not found' });
  }
}

module.exports = { createHandler };
