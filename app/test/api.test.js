'use strict';

process.env.NODE_ENV = 'test';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const app = require('../server');

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => server.close());

test('GET /health returns ok', async () => {
  const res = await fetch(`${base}/health`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { status: 'ok' });
});

test('GET /api/products returns all products', async () => {
  const res = await fetch(`${base}/api/products`);
  const list = await res.json();
  assert.strictEqual(res.status, 200);
  assert.ok(list.length >= 10);
});

test('GET /api/products filters by category', async () => {
  const list = await (await fetch(`${base}/api/products?category=sports`)).json();
  assert.ok(list.length > 0);
  assert.ok(list.every(p => p.category === 'sports'));
});

test('GET /api/products/:id returns 404 for unknown id', async () => {
  const res = await fetch(`${base}/api/products/9999`);
  assert.strictEqual(res.status, 404);
});

test('POST /api/orders creates an order with server-side prices', async () => {
  const res = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer: { name: 'Test User', email: 'test@example.com', address: 'Chennai' },
      items: [{ id: 1, qty: 2 }]
    })
  });
  const order = await res.json();
  assert.strictEqual(res.status, 201);
  assert.match(order.id, /^ORD-/);
  assert.strictEqual(order.subtotal, 2499 * 2);
  assert.strictEqual(order.shipping, 0);
});

test('POST /api/orders rejects an empty cart', async () => {
  const res = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer: { name: 'A', email: 'a@b.co', address: 'X' }, items: [] })
  });
  assert.strictEqual(res.status, 400);
});

test('index.html is served', async () => {
  const res = await fetch(`${base}/`);
  const html = await res.text();
  assert.strictEqual(res.status, 200);
  assert.ok(html.includes('ShopEase'));
});
