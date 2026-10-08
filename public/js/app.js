import { request } from "./api.js";
import { trendChart } from "./chart.js";
import { dayLabel, escapeHtml, money, perMonth, titleWord, units } from "./format.js";

const state = {
  view: "home",
  products: [],
  overview: null,
  error: "",
  loading: true,
  cart: [],
  payment: "Cash",
  sellQuery: "",
  stockQuery: "",
  stockFilter: "all",
  sheet: null,
  insight: "revenue",
  rank: "revenue",
};

const app = document.querySelector("#app");
const viewEl = document.querySelector("#view");

app.addEventListener("click", onClick);
app.addEventListener("input", onInput);
app.addEventListener("submit", onSubmit);
app.addEventListener("change", onChange);
window.addEventListener("popstate", () => {
  state.view = normalize(location.hash);
  state.sheet = null;
  render();
});

boot();

async function boot() {
  if (!location.hash) history.replaceState(null, "", "#home");
  state.view = normalize(location.hash);
  render();
  try {
    await reload();
  } catch (error) {
    state.loading = false;
    state.error = error.message;
    render();
  }
}

async function reload() {
  const [products, overview] = await Promise.all([
    request("/api/products"),
    request("/api/analytics/overview"),
  ]);
  state.products = products.products || [];
  state.overview = overview;
  state.error = "";
  state.loading = false;
  clampCart();
  render();
}

function normalize(hash) {
  const name = String(hash || "").replace("#", "");
  return ["home", "sell", "stock", "insights"].includes(name) ? name : "home";
}

function showView(name) {
  const next = normalize(name);
  state.view = next;
  state.sheet = null;
  if (location.hash !== "#" + next) history.pushState(null, "", "#" + next);
  render();
}

function render() {
  const keepScroll = viewEl.dataset.view === state.view && !state.loading;
  const scroll = viewEl.scrollTop;
  viewEl.dataset.view = state.view;
  viewEl.innerHTML = viewHtml();
  viewEl.scrollTop = keepScroll ? scroll : 0;
  paintDock();
  for (const button of app.querySelectorAll(".tabs button")) {
    button.setAttribute("aria-current", button.dataset.view === state.view ? "page" : "false");
  }
  renderSheet();
}

function renderSheet() {
  document.querySelector("#sheet").innerHTML = sheetHtml();
}

function viewHtml() {
  if (state.loading) return `<div class="loading">Opening the counter…</div>`;
  if (state.error) {
    return `<div class="banner"><p>${escapeHtml(state.error)}</p><button class="primary" type="button" data-action="retry">Try again</button></div>`;
  }
  if (state.view === "sell") return sellHtml();
  if (state.view === "stock") return stockHtml();
  if (state.view === "insights") return insightsHtml();
  return homeHtml();
}

function homeHtml() {
  const overview = state.overview;
  const kpis = overview.kpis;
  const revenue = overview.forecast.revenue;
  const outlook =
    kpis.nextMonthForecast == null
      ? { label: "Year revenue", value: money(kpis.yearRevenue), note: "Full year recorded" }
      : {
          label: kpis.nextMonthLabel + " outlook",
          value: money(kpis.nextMonthForecast),
          note: revenue.model ? perMonth(revenue.model.slope, true) : "Need more months",
        };
  const top = overview.topProducts.slice(0, 3);
  return `
    <header class="hero">
      <p class="eyebrow">MF Electronics</p>
      <h1>Counter</h1>
      <p class="date">${escapeHtml(dayLabel(overview.asOf))}</p>
      <p class="hero-label">Today</p>
      <p class="hero-value">${escapeHtml(money(kpis.todayRevenue))}</p>
      <p class="hero-sub">${escapeHtml(units(kpis.todayUnits))} units · ${escapeHtml(units(kpis.todayTickets))} ${kpis.todayTickets === 1 ? "ticket" : "tickets"}</p>
    </header>
    <div class="pad overlap">
      <div class="grid">
        <div class="tile"><span>This month</span><strong>${escapeHtml(money(kpis.monthRevenue))}</strong><em>${escapeHtml(units(kpis.monthUnits))} units</em></div>
        <div class="tile"><span>${escapeHtml(outlook.label)}</span><strong>${escapeHtml(outlook.value)}</strong><em>${escapeHtml(outlook.note)}</em></div>
        <button class="tile warn" type="button" data-action="low-stock"><span>Low stock</span><strong>${escapeHtml(units(kpis.lowStockCount))}</strong><em>Open the list</em></button>
        <div class="tile"><span>Stock at cost</span><strong>${escapeHtml(money(kpis.inventoryCost))}</strong><em>${escapeHtml(units(kpis.productCount))} products</em></div>
      </div>
    </div>
    <section class="section">
      <div class="section-head">
        <h2>Sales trend</h2>
        <button class="linkish" type="button" data-action="go" data-view="insights">See the model</button>
      </div>
      <div class="card chart">
        ${trendChart(revenue.series, { compact: true, label: "Revenue trend with linear regression forecast" })}
        <p class="fine">${escapeHtml(revenue.message || "")}</p>
      </div>
    </section>
    <section class="section">
      <div class="section-head">
        <h2>Top sellers</h2>
        <button class="linkish" type="button" data-action="go" data-view="insights">All products</button>
      </div>
      ${top.length ? top.map((product, index) => rankRow(product, index, "revenue")).join("") : `<p class="empty">Sales will show up here after the first paid ticket.</p>`}
    </section>
    <section class="section" style="padding-bottom: 16px">
      <h2>Restock</h2>
      ${restockCards(overview.lowStock.slice(0, 3))}
    </section>
  `;
}

function sellHtml() {
  const products = filteredProducts(state.sellQuery);
  return `
    <div class="page-head">
      <div>
        <p class="kicker">Register</p>
        <h1>Sell</h1>
      </div>
    </div>
    <div class="toolbar">
      <input id="sell-search" class="search" placeholder="Search products" value="${escapeHtml(state.sellQuery)}" autocomplete="off" enterkeyhint="search" />
    </div>
    <div class="list" id="sell-list">${sellCards(products)}</div>
  `;
}

function sellCards(products = filteredProducts(state.sellQuery)) {
  if (!products.length) return `<p class="empty">No products match that search.</p>`;
  return products
    .map((product) => {
      const inCart = cartQty(product.id);
      const gone = product.stock <= 0;
      return `
        <article class="product">
          <div class="product-top">
            <div class="grow">
              <strong>${escapeHtml(product.name)}</strong>
              <small>${escapeHtml(product.category || "Uncategorized")} · ${escapeHtml(money(product.price))}</small>
            </div>
            <div>
              <div class="stock-pill ${product.stock <= product.reorder ? "low" : ""}">${escapeHtml(units(product.stock))} on hand</div>
            </div>
            <button class="icon-btn" type="button" data-action="add" data-id="${escapeHtml(product.id)}" aria-label="Add ${escapeHtml(product.name)}" ${gone || inCart >= product.stock ? "disabled" : ""}>+</button>
          </div>
          ${inCart ? `<p class="fine">${escapeHtml(units(inCart))} in the cart</p>` : ""}
        </article>
      `;
    })
    .join("");
}

function cartBar() {
  const count = state.cart.reduce((sum, line) => sum + line.qty, 0);
  if (!count || state.view !== "sell") return "";
  return `
    <button class="cart-bar" type="button" data-action="open-cart">
      <span>${escapeHtml(units(count))} ${count === 1 ? "item" : "items"}</span>
      <strong>Cart ${escapeHtml(money(cartTotal()))}</strong>
    </button>
  `;
}

function stockHtml() {
  const products = stockList();
  return `
    <div class="page-head">
      <div>
        <p class="kicker">Warehouse</p>
        <h1>Stock</h1>
      </div>
      <button class="primary" type="button" data-action="create-product">Add</button>
    </div>
    <div class="toolbar">
      <input id="stock-search" class="search" placeholder="Search name or SKU" value="${escapeHtml(state.stockQuery)}" autocomplete="off" />
    </div>
    <div class="filters">
      <button class="chip ${state.stockFilter === "all" ? "on" : ""}" type="button" data-action="stock-filter" data-filter="all">All</button>
      <button class="chip ${state.stockFilter === "low" ? "on" : ""}" type="button" data-action="stock-filter" data-filter="low">Low</button>
    </div>
    <div class="list" id="stock-list">
      ${products.length ? products.map(stockRow).join("") : `<p class="empty">Nothing in this list.</p>`}
    </div>
  `;
}

function stockRow(product) {
  const low = Number(product.reorder) > 0 && Number(product.stock) <= Number(product.reorder);
  return `
    <button class="product" type="button" data-action="edit-product" data-id="${escapeHtml(product.id)}">
      <div class="product-top">
        <div class="grow">
          <strong>${escapeHtml(product.name)}</strong>
          <small>${escapeHtml(product.sku || "No SKU")} · ${escapeHtml(product.category || "Uncategorized")}</small>
        </div>
        <div>
          <b class="stock-pill ${low ? "low" : ""}">${escapeHtml(units(product.stock))}</b>
          <small>${escapeHtml(money(product.price))}</small>
        </div>
      </div>
    </button>
  `;
}

function insightsHtml() {
  const selected = selectedSeries();
  const model = selected.model;
  return `
    <div class="page-head">
      <div>
        <p class="kicker">Linear regression</p>
        <h1>Insights</h1>
      </div>
    </div>
    <section class="section">
      <div class="chips" aria-label="Forecast series">${insightChips()}</div>
      <div class="card chart">
        ${trendChart(selected.series, { label: selected.title + " trend and forecast" })}
        <div class="legend">
          <span><i class="swatch"></i>Recorded</span>
          <span><i class="swatch line"></i>Learned line</span>
          <span><i class="swatch dash"></i>Forecast</span>
        </div>
        ${
          model
            ? `<p class="equation">${escapeHtml(equation(model, selected.money))}</p>
               <div class="model">
                 <span class="pill ${escapeHtml(model.trend)}">${escapeHtml(titleWord(model.trend))}</span>
                 <span class="pill ${escapeHtml(model.confidence)}">${escapeHtml(titleWord(model.confidence))} confidence</span>
                 <span class="pill">R² ${escapeHtml(model.rSquared.toFixed(2))}</span>
               </div>
               <p class="fine">${escapeHtml(perMonth(model.slope, selected.money))}. ${escapeHtml(selected.message || "")} The line minimizes mean squared error on months that already happened.</p>`
            : `<p class="fine">${escapeHtml(selected.message || "Record at least two months, including one with sales, to learn a line.")}</p>`
        }
      </div>
      ${selected.recommendation ? recommendationBlock(selected.recommendation, selected.title) : ""}
    </section>
    <section class="section" style="padding-bottom: 18px">
      <div class="section-head">
        <h2>Top selling</h2>
        <div class="filters" style="padding:0">
          <button class="chip ${state.rank === "revenue" ? "on" : ""}" type="button" data-action="rank" data-rank="revenue">Revenue</button>
          <button class="chip ${state.rank === "units" ? "on" : ""}" type="button" data-action="rank" data-rank="units">Units</button>
        </div>
      </div>
      <div id="rank-list">${rankedProducts().map((product, index) => rankRow(product, index, state.rank)).join("") || `<p class="empty">No retail sales in ${escapeHtml(state.overview.year)} yet.</p>`}</div>
      <p class="fine">Rankings use paid retail tickets. A ticket of 100 units or more is left out so one bulk order does not become the top seller. Revenue on the chart still includes those tickets.</p>
    </section>
  `;
}

function insightChips() {
  const products = state.overview.forecast.products;
  const chips = [
    `<button class="chip ${state.insight === "revenue" ? "on" : ""}" type="button" data-action="insight" data-id="revenue">Revenue</button>`,
  ];
  for (const product of products) {
    const on = String(state.insight) === String(product.id);
    chips.push(
      `<button class="chip ${on ? "on" : ""}" type="button" data-action="insight" data-id="${escapeHtml(product.id)}">${escapeHtml(product.name)}</button>`
    );
  }
  return chips.join("");
}

function selectedSeries() {
  const forecast = state.overview.forecast;
  if (state.insight === "revenue") {
    return {
      title: "Revenue",
      money: true,
      series: forecast.revenue.series,
      model: forecast.revenue.model,
      message: forecast.revenue.message,
      recommendation: null,
    };
  }
  const product = forecast.products.find((entry) => String(entry.id) === String(state.insight));
  if (!product) {
    return { title: "Product", money: false, series: [], model: null, message: "Choose a product.", recommendation: null };
  }
  return {
    title: product.name,
    money: false,
    series: product.series,
    model: product.model,
    message: product.message,
    recommendation: product.inventoryRecommendation,
  };
}

function equation(model, asMoney) {
  const intercept = asMoney ? money(model.intercept) : units(model.intercept);
  const slope = asMoney ? money(Math.abs(model.slope)) : units(Math.abs(model.slope));
  const sign = model.slope < 0 ? "−" : "+";
  return `sales = ${intercept} ${sign} ${slope} × month`;
}

function rankRow(product, index, metric) {
  const share = metric === "units" ? product.unitShare : product.revenueShare;
  const headline = metric === "units" ? units(product.units) + " units" : money(product.revenue);
  const detail =
    metric === "units"
      ? `${money(product.revenue)} · ${product.category}`
      : `${units(product.units)} units · ${product.category}`;
  return `
    <article class="rank">
      <div class="rank-top">
        <span class="idx">${index + 1}</span>
        <div class="grow">
          <strong>${escapeHtml(product.name)}</strong>
          <small>${escapeHtml(detail)}</small>
        </div>
        <b>${escapeHtml(headline)}</b>
      </div>
      <div class="meter" aria-hidden="true"><span style="width:${Math.max(4, Math.round(share * 100))}%"></span></div>
    </article>
  `;
}

function restockCards(items) {
  if (!items.length) return `<p class="empty">Nothing is at or below its reorder point.</p>`;
  return items
    .map((item) => {
      const suggestion = item.recommendation;
      const extra = suggestion
        ? suggestion.message
        : `${units(item.stock)} on hand, reorder at ${units(item.reorder)}.`;
      return `<article class="callout"><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(extra)}</p></article>`;
    })
    .join("");
}

function recommendationBlock(recommendation, title) {
  return `
    <article class="callout">
      <h3>${escapeHtml(recommendation.suggestedOrderQuantity > 0 ? "Order " + units(recommendation.suggestedOrderQuantity) : "Stock covers the forecast")}</h3>
      <p>${escapeHtml(title)} · ${escapeHtml(recommendation.message)} Supplier cost ${escapeHtml(money(recommendation.supplierPayment))}.</p>
    </article>
  `;
}

function sheetHtml() {
  if (!state.sheet) return "";
  if (state.sheet.type === "cart") return cartSheet();
  if (state.sheet.type === "receipt") return receiptSheet(state.sheet.sale);
  if (state.sheet.type === "edit" || state.sheet.type === "create") return productSheet();
  return "";
}

function cartSheet() {
  const lines = state.cart
    .map((line) => {
      const product = findProduct(line.productId);
      if (!product) return "";
      return `
        <div class="line">
          <div class="grow">
            <strong>${escapeHtml(product.name)}</strong>
            <small>${escapeHtml(money(product.price))} each</small>
          </div>
          <div class="stepper">
            <button type="button" data-action="cart-dec" data-id="${escapeHtml(product.id)}" aria-label="Decrease ${escapeHtml(product.name)}">−</button>
            <span>${escapeHtml(units(line.qty))}</span>
            <button type="button" data-action="cart-inc" data-id="${escapeHtml(product.id)}" aria-label="Increase ${escapeHtml(product.name)}" ${line.qty >= product.stock ? "disabled" : ""}>+</button>
          </div>
        </div>
      `;
    })
    .join("");
  return overlay(`
    <h2>Cart</h2>
    ${lines || `<p class="empty">The cart is empty.</p>`}
    <div class="field" style="margin-top:14px">
      <span>Payment</span>
      <div class="seg">
        ${["Cash", "Card", "GCash"]
          .map(
            (method) => `
            <label>
              <input type="radio" name="payment" value="${method}" ${state.payment === method ? "checked" : ""} />
              <span>${method}</span>
            </label>`
          )
          .join("")}
      </div>
    </div>
    <div class="total-row"><span>Total</span><b>${escapeHtml(money(cartTotal()))}</b></div>
    <button class="primary" type="button" data-action="checkout" style="width:100%" ${state.cart.length ? "" : "disabled"}>Charge ${escapeHtml(money(cartTotal()))}</button>
  `);
}

function receiptSheet(sale) {
  const lines = (sale.items || [])
    .map(
      (item) =>
        `<div class="line"><div class="grow"><strong>${escapeHtml(item.name)}</strong><small>× ${escapeHtml(units(item.qty))}</small></div><b>${escapeHtml(money(item.price * item.qty))}</b></div>`
    )
    .join("");
  return overlay(`
    <p class="kicker">Paid · ${escapeHtml(sale.payment || "")}</p>
    <h2>Sale recorded</h2>
    ${lines}
    <div class="total-row"><span>Total</span><b>${escapeHtml(money(sale.total))}</b></div>
    <div class="actions">
      <button class="ghost" type="button" data-action="close-sheet">Close</button>
      <button class="primary" type="button" data-action="new-sale">New sale</button>
    </div>
  `);
}

function productSheet() {
  const creating = state.sheet.type === "create";
  const product = creating ? { name: "", category: "", sku: "", price: "", cost: "", stock: "", reorder: "" } : findProduct(state.sheet.id);
  if (!product) return "";
  return overlay(`
    <h2>${creating ? "New product" : "Edit product"}</h2>
    <form id="product-form" class="stack">
      <label class="field">Name<input name="name" required maxlength="80" value="${escapeHtml(product.name)}" /></label>
      <div class="split">
        <label class="field">Category<input name="category" maxlength="40" value="${escapeHtml(product.category || "")}" /></label>
        <label class="field">SKU<input name="sku" maxlength="32" value="${escapeHtml(product.sku || "")}" /></label>
      </div>
      <div class="split">
        <label class="field">Price<input name="price" required inputmode="decimal" value="${escapeHtml(product.price)}" /></label>
        <label class="field">Cost<input name="cost" inputmode="decimal" value="${escapeHtml(product.cost ?? "")}" /></label>
      </div>
      ${
        creating
          ? `<div class="split">
              <label class="field">Starting stock<input name="stock" inputmode="numeric" value="0" /></label>
              <label class="field">Reorder at<input name="reorder" inputmode="numeric" value="0" /></label>
            </div>`
          : `<label class="field">Reorder at<input name="reorder" inputmode="numeric" value="${escapeHtml(product.reorder ?? 0)}" /></label>
             <div class="on-hand">
               <div><span>On hand</span><b id="on-hand">${escapeHtml(units(product.stock))}</b></div>
               <div class="stepper">
                 <button type="button" data-action="adjust" data-delta="-1" ${product.stock <= 0 ? "disabled" : ""} aria-label="Remove one from stock">−</button>
                 <button type="button" data-action="adjust" data-delta="1" aria-label="Add one to stock">+</button>
               </div>
             </div>`
      }
      <div class="actions">
        <button class="ghost" type="button" data-action="close-sheet">Cancel</button>
        <button class="primary" type="submit">${creating ? "Save product" : "Save changes"}</button>
      </div>
    </form>
  `);
}

function overlay(inner) {
  return `<div class="overlay" data-action="close-sheet"><div class="sheet"><div class="grab"></div>${inner}</div></div>`;
}

function onClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target || !app.contains(target)) return;
  const action = target.dataset.action;
  if (action === "close-sheet" && target.classList.contains("overlay") && event.target.closest(".sheet")) return;
  if (action === "go") showView(target.dataset.view);
  if (action === "retry") {
    state.loading = true;
    state.error = "";
    render();
    reload().catch((error) => {
      state.loading = false;
      state.error = error.message;
      render();
    });
  }
  if (action === "low-stock") {
    state.stockFilter = "low";
    showView("stock");
  }
  if (action === "add") addToCart(target.dataset.id);
  if (action === "open-cart") {
    state.sheet = { type: "cart" };
    renderSheet();
  }
  if (action === "close-sheet") closeSheet();
  if (action === "cart-inc") changeCart(target.dataset.id, 1);
  if (action === "cart-dec") changeCart(target.dataset.id, -1);
  if (action === "checkout") checkout();
  if (action === "new-sale") {
    state.sheet = null;
    showView("sell");
  }
  if (action === "stock-filter") {
    state.stockFilter = target.dataset.filter;
    paintStock();
  }
  if (action === "create-product") {
    state.sheet = { type: "create" };
    renderSheet();
  }
  if (action === "edit-product") {
    state.sheet = { type: "edit", id: target.dataset.id };
    renderSheet();
  }
  if (action === "adjust") adjustStock(Number(target.dataset.delta));
  if (action === "insight") {
    state.insight = target.dataset.id;
    render();
  }
  if (action === "rank") {
    state.rank = target.dataset.rank;
    const list = document.querySelector("#rank-list");
    if (list) {
      list.innerHTML =
        rankedProducts().map((product, index) => rankRow(product, index, state.rank)).join("") ||
        `<p class="empty">No retail sales in ${escapeHtml(state.overview.year)} yet.</p>`;
      for (const button of app.querySelectorAll("[data-action=rank]")) {
        button.classList.toggle("on", button.dataset.rank === state.rank);
      }
    } else render();
  }
}

function onInput(event) {
  if (event.target.id === "sell-search") {
    state.sellQuery = event.target.value;
    const list = document.querySelector("#sell-list");
    if (list) list.innerHTML = sellCards();
  }
  if (event.target.id === "stock-search") {
    state.stockQuery = event.target.value;
    paintStock();
  }
}

function onChange(event) {
  if (event.target.name === "payment") state.payment = event.target.value;
}

function onSubmit(event) {
  if (event.target.id !== "product-form") return;
  event.preventDefault();
  saveProduct(event.target);
}

function paintStock() {
  const list = document.querySelector("#stock-list");
  if (!list) return render();
  const products = stockList();
  list.innerHTML = products.length ? products.map(stockRow).join("") : `<p class="empty">Nothing in this list.</p>`;
  for (const button of app.querySelectorAll("[data-action=stock-filter]")) {
    button.classList.toggle("on", button.dataset.filter === state.stockFilter);
  }
}

function paintDock() {
  const dock = document.querySelector("#dock");
  if (dock) dock.innerHTML = cartBar();
}

function paintSell() {
  const list = document.querySelector("#sell-list");
  if (list) list.innerHTML = sellCards();
  paintDock();
}

function filteredProducts(query) {
  const needle = query.trim().toLowerCase();
  return state.products
    .filter((product) => {
      const hay = `${product.name || ""} ${product.sku || ""} ${product.category || ""}`.toLowerCase();
      return !needle || hay.includes(needle);
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function stockList() {
  return filteredProducts(state.stockQuery).filter((product) => {
    if (state.stockFilter !== "low") return true;
    return Number(product.reorder) > 0 && Number(product.stock) <= Number(product.reorder);
  });
}

function rankedProducts() {
  const list = state.overview.topProducts.slice();
  if (state.rank === "units") {
    list.sort((a, b) => b.units - a.units || b.revenue - a.revenue || String(a.name).localeCompare(String(b.name)));
  }
  return list;
}

function findProduct(id) {
  return state.products.find((product) => String(product.id) === String(id));
}

function cartQty(id) {
  const line = state.cart.find((entry) => String(entry.productId) === String(id));
  return line ? line.qty : 0;
}

function cartTotal() {
  return state.cart.reduce((sum, line) => {
    const product = findProduct(line.productId);
    return sum + (product ? product.price * line.qty : 0);
  }, 0);
}

function clampCart() {
  state.cart = state.cart
    .map((line) => {
      const product = findProduct(line.productId);
      if (!product) return null;
      return { productId: product.id, qty: Math.min(line.qty, Number(product.stock) || 0) };
    })
    .filter((line) => line && line.qty > 0);
}

function addToCart(id) {
  const product = findProduct(id);
  if (!product || Number(product.stock) <= 0) return;
  const line = state.cart.find((entry) => String(entry.productId) === String(id));
  if (line) {
    if (line.qty >= product.stock) {
      showToast("That's all that's on hand", "err");
      return;
    }
    line.qty += 1;
  } else {
    state.cart.push({ productId: product.id, qty: 1 });
  }
  showToast("Added " + product.name);
  paintSell();
}

function changeCart(id, delta) {
  const product = findProduct(id);
  const line = state.cart.find((entry) => String(entry.productId) === String(id));
  if (!line || !product) return;
  const next = line.qty + delta;
  if (next <= 0) state.cart = state.cart.filter((entry) => entry !== line);
  else if (next <= product.stock) line.qty = next;
  if (!state.cart.length) {
    state.sheet = null;
    render();
    return;
  }
  renderSheet();
  paintSell();
}

async function checkout() {
  if (!state.cart.length || checkout.busy) return;
  checkout.busy = true;
  try {
    const sale = await request("/api/sales", {
      method: "POST",
      body: JSON.stringify({
        payment: state.payment,
        buyerName: "Walk-in",
        items: state.cart.map((line) => ({ productId: line.productId, qty: line.qty })),
      }),
    });
    state.cart = [];
    state.sheet = { type: "receipt", sale };
    await reload();
  } catch (error) {
    showToast(error.message, "err");
  } finally {
    checkout.busy = false;
  }
}

async function adjustStock(delta) {
  if (!state.sheet || state.sheet.type !== "edit") return;
  const product = findProduct(state.sheet.id);
  if (!product) return;
  if (delta < 0 && product.stock <= 0) return;
  try {
    const updated = await request(`/api/products/${encodeURIComponent(state.sheet.id)}/stock-adjust`, {
      method: "POST",
      body: JSON.stringify({ stockDelta: delta }),
    });
    const index = state.products.findIndex((entry) => String(entry.id) === String(updated.id));
    if (index >= 0) state.products[index] = updated;
    const label = document.querySelector("#on-hand");
    if (label) label.textContent = units(updated.stock);
    const minus = document.querySelector("[data-action=adjust][data-delta='-1']");
    if (minus) minus.disabled = updated.stock <= 0;
    showToast(delta > 0 ? "Stock added" : "Stock removed");
  } catch (error) {
    showToast(error.message, "err");
  }
}

async function saveProduct(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const creating = state.sheet && state.sheet.type === "create";
  try {
    const saved = await request(creating ? "/api/catalog" : `/api/catalog/${encodeURIComponent(state.sheet.id)}`, {
      method: creating ? "POST" : "PUT",
      body: JSON.stringify(data),
    });
    state.sheet = null;
    await reload();
    showToast(creating ? "Product added" : "Saved " + saved.name);
  } catch (error) {
    showToast(error.message, "err");
  }
}

function closeSheet() {
  const edited = state.sheet && state.sheet.type === "edit";
  state.sheet = null;
  if (edited) reload().catch((error) => showToast(error.message, "err"));
  else render();
}

let toastTimer = 0;
function showToast(text, kind = "ok") {
  const toast = document.querySelector("#toast");
  toast.hidden = false;
  toast.dataset.kind = kind;
  toast.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}
