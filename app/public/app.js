(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');

  const state = {
    products: [],
    category: 'all',
    query: '',
    cart: loadCart()
  };

  function loadCart() {
    try { return JSON.parse(localStorage.getItem('shopease-cart')) || {}; } catch { return {}; }
  }
  function saveCart() {
    try { localStorage.setItem('shopease-cart', JSON.stringify(state.cart)); } catch { /* ignore */ }
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  // ---------- Products ----------
  async function loadProducts() {
    const res = await fetch('/api/products');
    state.products = await res.json();
    renderProducts();
    renderCart();
  }

  function filtered() {
    const q = state.query.toLowerCase();
    return state.products.filter(p =>
      (state.category === 'all' || p.category === state.category) &&
      (!q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
    );
  }

  function renderProducts() {
    const list = filtered();
    const grid = $('#grid');
    grid.innerHTML = '';
    $('#empty').classList.toggle('hidden', list.length > 0);

    for (const p of list) {
      const off = Math.round((1 - p.price / p.mrp) * 100);
      const card = document.createElement('article');
      card.className = 'card';
      card.innerHTML = `
        <div class="thumb" style="background:${p.color}">
          <span class="off">${off}% OFF</span>${p.emoji}
        </div>
        <div class="card-body">
          <div class="card-title"></div>
          <div class="rating">★ ${p.rating}</div>
          <div class="card-desc"></div>
          <div class="price-row"><span class="price">${inr(p.price)}</span><span class="mrp">${inr(p.mrp)}</span></div>
          <button class="btn btn-primary add-btn" data-id="${p.id}">Add to cart</button>
        </div>`;
      card.querySelector('.card-title').textContent = p.name;
      card.querySelector('.card-desc').textContent = p.description;
      grid.appendChild(card);
    }
  }

  // ---------- Cart ----------
  function cartLines() {
    return Object.entries(state.cart)
      .map(([id, qty]) => ({ product: state.products.find(p => p.id === Number(id)), qty }))
      .filter(l => l.product);
  }

  function totals() {
    const subtotal = cartLines().reduce((s, l) => s + l.product.price * l.qty, 0);
    const shipping = subtotal === 0 || subtotal >= 999 ? 0 : 49;
    return { subtotal, shipping, total: subtotal + shipping };
  }

  function renderCart() {
    const lines = cartLines();
    const count = lines.reduce((s, l) => s + l.qty, 0);
    $('#cartCount').textContent = count;

    const box = $('#cartItems');
    box.innerHTML = '';
    if (lines.length === 0) {
      box.innerHTML = '<p class="cart-empty">Your cart is empty.</p>';
    }
    for (const { product: p, qty } of lines) {
      const row = document.createElement('div');
      row.className = 'cart-item';
      row.innerHTML = `
        <div class="mini" style="background:${p.color}">${p.emoji}</div>
        <div class="info"><strong></strong>${inr(p.price)}</div>
        <div class="qty">
          <button data-dec="${p.id}" aria-label="Decrease">−</button>
          <span>${qty}</span>
          <button data-inc="${p.id}" aria-label="Increase">+</button>
        </div>`;
      row.querySelector('strong').textContent = p.name;
      box.appendChild(row);
    }

    const t = totals();
    $('#subtotal').textContent = inr(t.subtotal);
    $('#shipping').textContent = t.shipping === 0 ? 'Free' : inr(t.shipping);
    $('#total').textContent = inr(t.total);
    $('#checkoutBtn').disabled = lines.length === 0;
  }

  function addToCart(id) {
    state.cart[id] = Math.min((state.cart[id] || 0) + 1, 20);
    saveCart();
    renderCart();
    const p = state.products.find(x => x.id === Number(id));
    toast(`${p ? p.name : 'Item'} added to cart`);
  }

  function changeQty(id, delta) {
    const next = (state.cart[id] || 0) + delta;
    if (next <= 0) delete state.cart[id];
    else state.cart[id] = Math.min(next, 20);
    saveCart();
    renderCart();
  }

  function openCart() { $('#cart').classList.add('open'); $('#overlay').classList.remove('hidden'); }
  function closeCart() { $('#cart').classList.remove('open'); $('#overlay').classList.add('hidden'); }

  // ---------- Checkout ----------
  async function placeOrder(e) {
    e.preventDefault();
    const form = e.target;
    const err = $('#formError');
    err.classList.add('hidden');
    const body = {
      customer: { name: form.name.value.trim(), email: form.email.value.trim(), address: form.address.value.trim() },
      items: cartLines().map(l => ({ id: l.product.id, qty: l.qty }))
    };
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Order failed');
      state.cart = {};
      saveCart();
      renderCart();
      form.reset();
      $('#modal').classList.add('hidden');
      closeCart();
      toast(`🎉 Order ${data.id} placed! Total ${inr(data.total)}`);
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
  }

  // ---------- Version badge (proves which build/pod served you) ----------
  async function loadVersion() {
    try {
      const v = await (await fetch('/api/version')).json();
      $('#version').textContent = `build #${v.build} · pod ${v.pod}`;
    } catch { $('#version').textContent = 'build unknown'; }
  }

  // ---------- Events ----------
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.matches('.add-btn')) addToCart(t.dataset.id);
    if (t.dataset.inc) changeQty(t.dataset.inc, 1);
    if (t.dataset.dec) changeQty(t.dataset.dec, -1);
    if (t.matches('.chip')) {
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      t.classList.add('active');
      state.category = t.dataset.cat;
      renderProducts();
    }
  });
  $('#search').addEventListener('input', (e) => { state.query = e.target.value; renderProducts(); });
  $('#cartBtn').addEventListener('click', openCart);
  $('#closeCart').addEventListener('click', closeCart);
  $('#overlay').addEventListener('click', closeCart);
  $('#checkoutBtn').addEventListener('click', () => $('#modal').classList.remove('hidden'));
  $('#cancelCheckout').addEventListener('click', () => $('#modal').classList.add('hidden'));
  $('#checkoutForm').addEventListener('submit', placeOrder);

  loadProducts();
  loadVersion();
})();
