async function recordSale(store, body, now = new Date()) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, error: "Request body must be a JSON object." };
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { status: 400, error: "items must be a non-empty array." };
  }
  if (body.items.length > 50) {
    return { status: 400, error: "A sale can include at most 50 lines." };
  }

  const payment = body.payment == null || String(body.payment).trim() === "" ? "Cash" : String(body.payment).trim();
  if (payment.length > 40) return { status: 400, error: "payment is too long." };
  const buyerName =
    body.buyerName == null || String(body.buyerName).trim() === ""
      ? "Walk-in"
      : String(body.buyerName).trim();
  if (buyerName.length > 80) return { status: 400, error: "buyerName is too long." };

  const merged = new Map();
  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i];
    if (item == null || item.productId == null || item.productId === "") {
      return { status: 400, error: `items[${i}].productId is required.` };
    }
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      return { status: 400, error: `items[${i}].qty must be an integer from 1 to 99.` };
    }
    const key = String(item.productId);
    merged.set(key, (merged.get(key) || 0) + qty);
  }
  for (const [productId, qty] of merged) {
    if (qty > 99) {
      return { status: 400, error: `Quantity for product ${productId} must be from 1 to 99.` };
    }
  }

  try {
    const sale = await store.transaction(async (tx) => {
      const items = [];
      let total = 0;
      for (const [productId, qty] of merged) {
        const product = await tx.get("products", productId, { lock: true });
        if (!product) fail(404, "Product not found");
        const stock = Number(product.stock) || 0;
        if (stock < qty) {
          fail(409, `${product.name || "Product"} only has ${stock} in stock.`);
        }
        const price = Number(product.price);
        if (!Number.isFinite(price) || price < 0) {
          fail(400, `${product.name || "Product"} has no selling price.`);
        }
        product.stock = stock - qty;
        product.sold = Math.max(0, (Number(product.sold) || 0) + qty);
        await tx.upsert("products", product.id != null ? product.id : productId, product);
        const lineTotal = Math.round(price * qty * 100) / 100;
        total = Math.round((total + lineTotal) * 100) / 100;
        items.push({
          productId: product.id != null ? product.id : productId,
          name: product.name,
          qty,
          price,
        });
      }

      const data = {
        id: "TXN-" + now.getTime().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
        date: now.toISOString(),
        total,
        payment,
        buyerName,
        items,
        status: "paid",
      };
      await tx.upsert("transactions", data.id, data);
      return data;
    });
    return { status: 201, sale };
  } catch (error) {
    if (error.status) return { status: error.status, error: error.message };
    throw error;
  }
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

module.exports = {
  recordSale,
};
