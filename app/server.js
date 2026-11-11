'use strict';

const express = require('express');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const products = require('./data/products.json');

const app = express();
const PORT = process.env.PORT || 3000;
const BUILD_NUMBER = process.env.BUILD_NUMBER || 'local';
const STARTED_AT = new Date().toISOString();

// In-memory order store (demo only - resets when the pod restarts)
const orders = [];

// Structured JSON logs -> stdout -> Kubernetes -> CloudWatch Logs
function log(level, message, extra = {}) {
  if (process.env.NODE_ENV === 'test') return;
  console.log(JSON.stringify({ time: new Date().toISOString(), level, message, pod: os.hostname(), build: BUILD_NUMBER, ...extra }));
}

app.use(express.json({ limit: '100kb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path === '/health') return; // keep logs clean from probes
    log('info', 'request', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
  });
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true }));

// ---------- API ----------
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/version', (req, res) => {
  res.json({ build: BUILD_NUMBER, pod: os.hostname(), startedAt: STARTED_AT });
});

app.get('/api/products', (req, res) => {
  const { category, q } = req.query;
  let list = products;
  if (category && category !== 'all') list = list.filter(p => p.category === category);
  if (q) {
    const term = String(q).toLowerCase();
    list = list.filter(p => p.name.toLowerCase().includes(term) || p.description.toLowerCase().includes(term));
  }
  res.json(list);
});

app.get('/api/products/:id', (req, res) => {
  const product = products.find(p => p.id === Number(req.params.id));
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
});

app.post('/api/orders', (req, res) => {
  const { customer, items } = req.body || {};
  if (!customer || !customer.name || !customer.email || !customer.address) {
    return res.status(400).json({ error: 'Name, email and address are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' });
  }

  const lines = [];
  for (const item of items) {
    const product = products.find(p => p.id === Number(item.id));
    const qty = Number(item.qty);
    if (!product || !Number.isInteger(qty) || qty < 1 || qty > 20) {
      return res.status(400).json({ error: 'Invalid cart item' });
    }
    lines.push({ id: product.id, name: product.name, price: product.price, qty });
  }

  const subtotal = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  const shipping = subtotal >= 999 ? 0 : 49;
  const order = {
    id: 'ORD-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    customer: { name: customer.name, email: customer.email, address: customer.address },
    items: lines,
    subtotal,
    shipping,
    total: subtotal + shipping,
    createdAt: new Date().toISOString()
  };
  orders.push(order);
  log('info', 'order_placed', { orderId: order.id, total: order.total, items: lines.length });
  res.status(201).json(order);
});

app.get('/api/orders/:id', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Error handler
app.use((err, req, res, next) => {
  log('error', 'unhandled_error', { error: err.message });
  res.status(err.status || 500).json({ error: 'Something went wrong' });
});

if (require.main === module) {
  const server = app.listen(PORT, () => log('info', `ShopEase listening on port ${PORT}`));
  // Graceful shutdown so Kubernetes rolling updates drop zero requests
  process.on('SIGTERM', () => {
    log('info', 'SIGTERM received, shutting down');
    server.close(() => process.exit(0));
  });
}

module.exports = app;
