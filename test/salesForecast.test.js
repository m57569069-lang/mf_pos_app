const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAnalyticsForecast,
  regressionFromRequest,
  parseForecastYear,
} = require("../lib/salesForecast");

function closeTo(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon,
    `expected ${expected} ± ${epsilon}, got ${actual}`
  );
}

function point(series, month) {
  return series.find((entry) => entry.month === month);
}

test("monthly regression forecasts the learned line, not an earlier month", () => {
  // Jan–Jun units follow the demo zigzag. Copying the prior two-month
  // pattern would draw July as 30. The learned line is about 68.67.
  const result = regressionFromRequest({
    monthlyValues: [10, 60, 30, 40, 30, 80],
    lastActualMonth: 6,
    valueType: "units",
  });

  assert.equal(result.method, "linear_regression");
  assert.equal(result.hasSufficientData, true);
  assert.equal(result.model.confidence, "moderate");
  assert.equal(result.model.trend, "rising");
  closeTo(result.model.slope, 7.714285714285714);
  closeTo(result.model.intercept, 14.666666666666664);
  closeTo(result.model.rSquared, 0.3377606177606177);

  const july = point(result.series, 7);
  assert.equal(july.isActual, false);
  assert.equal(july.actual, null);
  closeTo(july.predicted, 68.66666666666666);
  assert.equal(july.value, 69);
  assert.notEqual(july.value, 30);

  assert.equal(point(result.series, 6).isActual, true);
  assert.equal(point(result.series, 6).value, 80);
  assert.deepEqual(
    result.series.slice(6).map((entry) => entry.value),
    [69, 76, 84, 92, 100, 107]
  );
});

test("placeholder zeros after the last real month are not used for learning", () => {
  const result = regressionFromRequest({
    monthlyValues: [10, 20, 30, 40, 0, 0],
    lastActualMonth: 4,
  });

  closeTo(result.model.slope, 10);
  closeTo(result.model.intercept, 0);
  assert.equal(result.model.n, 4);
  assert.equal(point(result.series, 5).value, 50);
  assert.equal(point(result.series, 4).value, 40);
});

test("a downward line is floored at zero for the chart", () => {
  const result = regressionFromRequest({
    monthlyValues: [10, 5, 0],
    lastActualMonth: 3,
    valueType: "units",
  });

  closeTo(result.model.slope, -5);
  assert.equal(result.model.trend, "falling");
  assert.ok(point(result.series, 4).predicted < 0);
  assert.equal(point(result.series, 4).value, 0);
  assert.equal(point(result.series, 6).value, 0);
});

test("money forecasts keep cents and generic pairs stay unclamped", () => {
  const money = regressionFromRequest({
    monthlyValues: [10.126, 20.2],
    valueType: "money",
  });
  assert.equal(point(money.series, 3).value, 30.27);

  const generic = regressionFromRequest({
    independent: [1, 2, 3],
    dependent: [2, 4, 6],
    predict: [4, 5],
  });
  assert.equal(generic.hasSufficientData, true);
  closeTo(generic.model.slope, 2);
  closeTo(generic.predictions[0].predicted, 8);
  closeTo(generic.predictions[1].predicted, 10);
  closeTo(generic.fitted[2].predicted, 6);
});

test("one point is not enough to learn a slope", () => {
  const result = regressionFromRequest({ monthlyValues: [10] });

  assert.equal(result.hasSufficientData, false);
  assert.equal(result.model, null);
  assert.equal(point(result.series, 1).value, 10);
  assert.equal(point(result.series, 2).value, null);
});

test("malformed regression requests are rejected", () => {
  assert.match(regressionFromRequest(null).error, /JSON object/);
  assert.match(regressionFromRequest({}).error, /monthlyValues/);
  assert.match(
    regressionFromRequest({ monthlyValues: [1, 2], independent: [1], dependent: [2] }).error,
    /not both/
  );
  assert.match(
    regressionFromRequest({ monthlyValues: [1, "nope"] }).error,
    /monthlyValues\[1\]/
  );
  assert.match(
    regressionFromRequest({ monthlyValues: [1, 2], lastActualMonth: 4 }).error,
    /cannot be past/
  );
  assert.match(
    regressionFromRequest({ independent: [1, 2], dependent: [1] }).error,
    /same length/
  );
  assert.match(
    regressionFromRequest({ monthlyValues: [1, 2], valueType: "kilos" }).error,
    /units or money/
  );
});

test("stored sales learn a product forecast and a restock quantity", () => {
  const now = new Date("2026-02-15T00:00:00.000Z");
  const forecast = buildAnalyticsForecast({
    now,
    year: 2026,
    products: [
      { id: 4, name: "Kingston Fury", category: "RAM", stock: 5, reorder: 4, cost: 100 },
      { id: 2, name: "Quiet Mouse", category: "Mouse", stock: 40, reorder: 2, cost: 25 },
    ],
    transactions: [
      sale("2026-01-15T00:00:00.000Z", 1000, [{ productId: 4, qty: 10 }, { productId: 2, qty: 1 }]),
      sale("2026-02-10T00:00:00.000Z", 3000, [{ productId: 4, qty: 20 }]),
      sale("2026-01-20T00:00:00.000Z", 500, [{ productId: 4, qty: 500 }], { buyerName: "Bulk Wholesale" }),
      sale("2026-02-11T00:00:00.000Z", 88888, [{ productId: 4, qty: 40 }], { payment: "Void" }),
      sale("2025-12-01T00:00:00.000Z", 7777, [{ productId: 4, qty: 9 }]),
    ],
    purchaseOrders: [
      {
        status: "partial",
        items: [{ productId: 4, qty: 100, receivedQty: 40 }],
      },
      {
        status: "cancelled",
        items: [{ productId: 4, qty: 1000, receivedQty: 0 }],
      },
    ],
  });

  assert.equal(forecast.year, 2026);
  assert.equal(forecast.lastActualMonth, 2);
  assert.equal(forecast.method, "linear_regression");

  const january = point(forecast.revenue.series, 1);
  const march = point(forecast.revenue.series, 3);
  // The wholesale ticket is excluded from unit demand, and its 500 still counts as revenue.
  assert.equal(january.value, 1500);
  assert.equal(march.isActual, false);
  assert.equal(march.value, 4500);

  const ram = forecast.products.find((product) => product.id === 4);
  assert.equal(ram.totalSold, 30);
  closeTo(ram.model.slope, 10);
  closeTo(ram.model.intercept, 0);
  assert.equal(point(ram.series, 3).value, 30);
  assert.equal(ram.inventoryRecommendation.forecastDemand, 750);
  assert.equal(ram.inventoryRecommendation.outstandingPoQuantity, 60);
  assert.equal(ram.inventoryRecommendation.suggestedOrderQuantity, 689);
  assert.equal(ram.inventoryRecommendation.supplierPayment, 68900);

  const mouse = forecast.products.find((product) => product.id === 2);
  assert.equal(mouse.totalSold, 1);
  // February has already happened with zero sales, so the line can learn.
  closeTo(mouse.model.slope, -1);
  assert.equal(mouse.model.trend, "falling");
  assert.equal(point(mouse.series, 3).value, 0);
  assert.equal(mouse.inventoryRecommendation.suggestedOrderQuantity, 0);
});

test("a product filter misses unknown ids and an explicit year is honored", () => {
  const now = new Date("2026-06-01T00:00:00.000Z");
  const missing = buildAnalyticsForecast({
    now,
    products: [{ id: 1, name: "Cable", stock: 3, reorder: 1, cost: 5 }],
    transactions: [],
    productId: "99",
  });
  assert.equal(missing.productNotFound, true);
  assert.equal(missing.products.length, 0);

  const previousYear = buildAnalyticsForecast({
    now,
    year: 2025,
    products: [{ id: 1, name: "Cable", stock: 3, reorder: 1, cost: 5 }],
    transactions: [
      sale("2025-01-05T00:00:00.000Z", 100, [{ productId: 1, qty: 2 }]),
      sale("2025-03-05T00:00:00.000Z", 150, [{ productId: 1, qty: 4 }]),
    ],
  });
  assert.equal(previousYear.year, 2025);
  assert.equal(previousYear.lastActualMonth, 12);
  assert.equal(point(previousYear.products[0].series, 12).isActual, true);
  assert.equal(previousYear.products[0].hasSufficientData, true);

  const onlyJanuary = buildAnalyticsForecast({
    now: new Date("2026-01-20T00:00:00.000Z"),
    products: [{ id: 1, name: "Cable", stock: 3, reorder: 1, cost: 5 }],
    transactions: [
      sale("2026-01-05T00:00:00.000Z", 100, [{ productId: 1, qty: 2 }]),
    ],
  });
  assert.equal(onlyJanuary.lastActualMonth, 1);
  assert.equal(onlyJanuary.products[0].hasSufficientData, false);
  assert.equal(onlyJanuary.products[0].model, null);
  assert.equal(point(onlyJanuary.products[0].series, 2).value, null);
});

test("parseForecastYear accepts a blank and rejects junk", () => {
  assert.equal(parseForecastYear(undefined), undefined);
  assert.equal(parseForecastYear(""), undefined);
  assert.equal(parseForecastYear("2026"), 2026);
  assert.equal(parseForecastYear("1999"), null);
  assert.equal(parseForecastYear("2026.5"), null);
  assert.equal(parseForecastYear("year"), null);
});

function sale(date, total, items, extra = {}) {
  return {
    date,
    total,
    payment: extra.payment || "Cash",
    buyerName: extra.buyerName || "Maria Santos",
    items,
  };
}
