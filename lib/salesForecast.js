const { fitLinearRegression, predict } = require("./linearRegression");

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const FORECAST_NOTES = [
  "Forecasts use ordinary least squares linear regression. Month number (1-12) is the independent variable and the monthly total is the dependent variable.",
  "The line is learned only from months that have already occurred, including months with zero sales. Later months are that line, floored at zero.",
  "Void, cancelled, deleted, and unpaid tickets are excluded.",
  "Bulk, wholesale, and corporate tickets, and any ticket of 100 units or more, are left out of product unit forecasts so one large order does not tilt the trend. Those tickets still count toward revenue.",
];

function buildAnalyticsForecast(input = {}) {
  const now = input.now instanceof Date && !Number.isNaN(input.now.getTime())
    ? input.now
    : new Date();
  const products = Array.isArray(input.products) ? input.products : [];
  const transactions = Array.isArray(input.transactions) ? input.transactions : [];
  const purchaseOrders = Array.isArray(input.purchaseOrders) ? input.purchaseOrders : [];
  const requestedProductId = blankToUndefined(input.productId);

  const validTransactions = transactions.filter(isValidSale);
  const year = input.year == null ? resolveYear(validTransactions, now) : input.year;
  const lastActualMonth = calendarLastActual(year, now);

  const revenueByMonth = Array(12).fill(0);
  const unitsByProduct = new Map();
  for (const product of products) {
    if (product == null || product.id == null || product.id === "") continue;
    unitsByProduct.set(String(product.id), Array(12).fill(0));
  }

  for (const transaction of validTransactions) {
    const stamp = stampOf(transaction);
    if (!stamp || stamp.year !== year) continue;
    const total = asNumber(transaction.total);
    if (total != null && total > 0) revenueByMonth[stamp.month - 1] += total;

    if (isBulkSale(transaction)) continue;
    for (const item of transaction.items || []) {
      const productId = itemProductId(item);
      const qty = itemQty(item);
      if (productId == null || qty == null || qty <= 0) continue;
      const bucket = unitsByProduct.get(String(productId));
      if (!bucket) continue;
      bucket[stamp.month - 1] += qty;
    }
  }

  const revenue = projectMonthlySeries(revenueByMonth, lastActualMonth, {
    valueType: "money",
    valueLabel: "revenue",
  });

  let productNotFound = false;
  const catalog = products.filter((product) => product != null && product.id != null && product.id !== "");
  const selected = requestedProductId == null
    ? catalog
    : catalog.filter((product) => sameId(product.id, requestedProductId));
  if (requestedProductId != null && selected.length === 0) productNotFound = true;

  const productForecasts = selected.map((product) => {
    const units = unitsByProduct.get(String(product.id)) || Array(12).fill(0);
    const projected = projectMonthlySeries(units, lastActualMonth, {
      valueType: "units",
      valueLabel: "sales",
      subject: productName(product),
    });
    const totalSold = units.slice(0, lastActualMonth).reduce((sum, qty) => sum + qty, 0);
    return {
      id: product.id,
      name: productName(product),
      category: product.category || "Uncategorized",
      totalSold,
      currentStock: nonNegativeInt(product.stock),
      reorderLevel: nonNegativeInt(product.reorder ?? product.reorderLevel),
      hasSufficientData: projected.hasSufficientData,
      message: projected.message,
      model: projected.model,
      series: projected.series,
      inventoryRecommendation: projected.hasSufficientData
        ? inventoryRecommendation(product, projected.series, purchaseOrders)
        : null,
    };
  });

  productForecasts.sort((a, b) => {
    if (b.totalSold !== a.totalSold) return b.totalSold - a.totalSold;
    return String(a.name).localeCompare(String(b.name));
  });

  return {
    method: "linear_regression",
    objective: "minimize_mean_squared_error",
    year,
    asOf: now.toISOString(),
    calendarMonth: now.getUTCMonth() + 1,
    lastActualMonth,
    notes: FORECAST_NOTES,
    revenue,
    products: productForecasts,
    productNotFound,
  };
}

function regressionFromRequest(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object." };
  }

  const hasMonthly = body.monthlyValues != null;
  const hasPairs = body.independent != null || body.dependent != null;
  if (hasMonthly && hasPairs) {
    return {
      error: "Send either monthlyValues or independent and dependent, not both.",
    };
  }
  if (hasPairs) return genericFromRequest(body);
  if (!hasMonthly) {
    return {
      error: "Provide monthlyValues, or independent and dependent arrays.",
    };
  }
  return learnMonthlyRegression(body);
}

function learnMonthlyRegression(body) {
  if (!Array.isArray(body.monthlyValues)) {
    return { error: "monthlyValues must be an array of numbers." };
  }
  if (body.monthlyValues.length === 0 || body.monthlyValues.length > 12) {
    return { error: "monthlyValues must contain from 1 to 12 numbers." };
  }

  const values = [];
  for (let i = 0; i < body.monthlyValues.length; i++) {
    const value = asNumber(body.monthlyValues[i]);
    if (value == null) {
      return { error: `monthlyValues[${i}] must be a finite number.` };
    }
    values.push(value);
  }

  const valueType = body.valueType == null ? "units" : body.valueType;
  if (valueType !== "units" && valueType !== "money") {
    return { error: "valueType must be units or money." };
  }

  let lastActualMonth = values.length;
  if (body.lastActualMonth != null && body.lastActualMonth !== "") {
    const parsed = asNumber(body.lastActualMonth);
    if (parsed == null || !Number.isInteger(parsed) || parsed < 1 || parsed > 12) {
      return { error: "lastActualMonth must be an integer from 1 to 12." };
    }
    if (parsed > values.length) {
      return { error: "lastActualMonth cannot be past the end of monthlyValues." };
    }
    lastActualMonth = parsed;
  }

  const actual = Array(12).fill(0);
  for (let month = 1; month <= lastActualMonth; month++) {
    actual[month - 1] = values[month - 1];
  }

  const projected = projectMonthlySeries(actual, lastActualMonth, {
    valueType,
    valueLabel: valueType === "money" ? "revenue" : "sales",
  });

  return {
    method: "linear_regression",
    objective: "minimize_mean_squared_error",
    valueType,
    lastActualMonth,
    hasSufficientData: projected.hasSufficientData,
    message: projected.message,
    model: projected.model,
    series: projected.series,
  };
}

function genericFromRequest(body) {
  if (!Array.isArray(body.independent) || !Array.isArray(body.dependent)) {
    return { error: "independent and dependent must both be arrays of numbers." };
  }
  if (body.independent.length !== body.dependent.length) {
    return { error: "independent and dependent must be the same length." };
  }
  if (body.independent.length > 5000) {
    return { error: "A regression request can include at most 5000 points." };
  }

  const independent = [];
  const dependent = [];
  for (let i = 0; i < body.independent.length; i++) {
    const x = asNumber(body.independent[i]);
    const y = asNumber(body.dependent[i]);
    if (x == null || y == null) {
      return { error: `Point ${i} must be a pair of finite numbers.` };
    }
    independent.push(x);
    dependent.push(y);
  }

  let predictXs = null;
  if (body.predict != null) {
    if (!Array.isArray(body.predict) || body.predict.length > 366) {
      return { error: "predict must be an array of at most 366 numbers." };
    }
    predictXs = [];
    for (let i = 0; i < body.predict.length; i++) {
      const x = asNumber(body.predict[i]);
      if (x == null) return { error: `predict[${i}] must be a finite number.` };
      predictXs.push(x);
    }
  }

  if (independent.length < 2) {
    return {
      method: "linear_regression",
      objective: "minimize_mean_squared_error",
      hasSufficientData: false,
      message: "At least two points are required to learn a linear regression.",
      model: null,
      fitted: independent.map((x, i) => ({ x, y: dependent[i], predicted: null })),
      ...(predictXs ? { predictions: null } : {}),
    };
  }

  const fit = fitLinearRegression(independent, dependent);
  const fitted = independent.map((x, i) => ({
    x,
    y: dependent[i],
    predicted: predict(fit, x),
  }));
  const result = {
    method: "linear_regression",
    objective: "minimize_mean_squared_error",
    hasSufficientData: true,
    message: `Linear regression learned ${fit.equation} (R² ${fit.rSquared.toFixed(2)}, ${fit.confidence} confidence).`,
    model: publicModel(fit),
    fitted,
  };
  if (predictXs) {
    result.predictions = predictXs.map((x) => ({ x, predicted: predict(fit, x) }));
  }
  return result;
}

function projectMonthlySeries(actualByMonth, lastActualMonth, options) {
  const valueType = options.valueType;
  const xs = [];
  const ys = [];
  for (let month = 1; month <= lastActualMonth; month++) {
    xs.push(month);
    ys.push(actualByMonth[month - 1] || 0);
  }

  const positiveMonths = ys.filter((value) => value > 0).length;
  const hasSufficientData = xs.length >= 2 && positiveMonths >= 1;
  const fit = hasSufficientData
    ? fitLinearRegression(xs, ys, { variableName: "month" })
    : null;

  const series = [];
  for (let month = 1; month <= 12; month++) {
    const isActual = month <= lastActualMonth;
    const actual = isActual ? ys[month - 1] : null;
    let predicted = null;
    if (fit) predicted = predict(fit, month);
    series.push({
      month,
      label: MONTH_LABELS[month - 1],
      actual,
      predicted,
      value: isActual ? actual : displayForecast(predicted, valueType),
      isActual,
    });
  }

  return {
    lastActualMonth,
    hasSufficientData,
    message: seriesMessage(options, lastActualMonth, fit, hasSufficientData),
    model: fit ? publicModel(fit) : null,
    series,
  };
}

function seriesMessage(options, lastActualMonth, fit, hasSufficientData) {
  const subject = options.subject ? ` for ${options.subject}` : "";
  if (!hasSufficientData) {
    return `At least two recorded months, including one with ${options.valueLabel}, are needed before linear regression can learn a trend${subject}.`;
  }
  const score = `R² ${fit.rSquared.toFixed(2)}, ${fit.confidence} confidence`;
  if (lastActualMonth >= 12) {
    return `Linear regression learned ${fit.equation} from the full year${subject} (${score}).`;
  }
  const end = MONTH_LABELS[lastActualMonth - 1];
  return `Linear regression learned ${fit.equation} from Jan–${end}${subject} (${fit.n} months, ${score}). Later months follow that line.`;
}

function inventoryRecommendation(product, series, purchaseOrders) {
  const currentStock = nonNegativeInt(product.stock);
  const reorderLevel = nonNegativeInt(product.reorder ?? product.reorderLevel);
  const forecastDemand = series
    .filter((point) => !point.isActual && point.value != null)
    .reduce((sum, point) => sum + point.value, 0);
  const outstandingPoQuantity = outstandingQuantity(purchaseOrders, product.id);
  const suggestedOrderQuantity = Math.max(
    0,
    Math.round(forecastDemand + reorderLevel - currentStock - outstandingPoQuantity)
  );
  const unitCost = asNumber(product.cost) || 0;
  const message = suggestedOrderQuantity > 0
    ? `Based on the linear regression forecast, order ${suggestedOrderQuantity} more units to cover the remaining months plus safety stock.`
    : "Current stock and outstanding purchase orders cover the regression forecast and safety stock.";

  return {
    currentStock,
    reorderLevel,
    safetyStock: reorderLevel,
    forecastDemand,
    outstandingPoQuantity,
    suggestedOrderQuantity,
    supplierPayment: roundMoney(suggestedOrderQuantity * Math.max(0, unitCost)),
    message,
  };
}

function outstandingQuantity(purchaseOrders, productId) {
  let outstanding = 0;
  for (const order of purchaseOrders) {
    if (order == null || isCancelled(order.status)) continue;
    for (const item of order.items || []) {
      if (!sameId(itemProductId(item), productId)) continue;
      const ordered = itemQty(item) || 0;
      const received = nonNegativeInt(item.receivedQty ?? item.received_qty);
      outstanding += Math.max(0, ordered - received);
    }
  }
  return outstanding;
}

function publicModel(fit) {
  return {
    slope: fit.slope,
    intercept: fit.intercept,
    rSquared: fit.rSquared,
    mse: fit.mse,
    rmse: fit.rmse,
    n: fit.n,
    mean: fit.mean,
    confidence: fit.confidence,
    trend: fit.trend,
    equation: fit.equation,
    loss: fit.loss,
  };
}

function displayForecast(predicted, valueType) {
  if (predicted == null || !Number.isFinite(predicted)) return null;
  const clamped = Math.max(0, predicted);
  if (valueType === "money") return roundMoney(clamped);
  return Math.round(clamped);
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function calendarLastActual(year, now) {
  const currentYear = now.getUTCFullYear();
  if (year < currentYear) return 12;
  if (year > currentYear) return 0;
  return now.getUTCMonth() + 1;
}

function resolveYear(transactions, now) {
  const current = now.getUTCFullYear();
  let latest = null;
  for (const transaction of transactions) {
    const stamp = stampOf(transaction);
    if (!stamp) continue;
    if (stamp.year === current) return current;
    if (latest == null || stamp.year > latest) latest = stamp.year;
  }
  return latest == null ? current : latest;
}

function parseForecastYear(value) {
  if (value == null || value === "") return undefined;
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  return year;
}

function isValidSale(transaction) {
  if (transaction == null || typeof transaction !== "object") return false;
  if (includesAny(transaction.payment, ["void", "cancel", "delete", "unpaid"])) return false;
  if (includesAny(transaction.buyerName ?? transaction.buyer_name, ["void", "cancel", "deleted"])) {
    return false;
  }
  if (!Array.isArray(transaction.items) || transaction.items.length === 0) return false;
  const total = asNumber(transaction.total);
  if (total == null || total <= 0) return false;
  return stampOf(transaction) != null;
}

function isBulkSale(transaction) {
  if (includesAny(transaction.buyerName ?? transaction.buyer_name, ["bulk", "wholesale", "corporate"])) {
    return true;
  }
  const units = (transaction.items || []).reduce((sum, item) => sum + (itemQty(item) || 0), 0);
  return units >= 100;
}

function isCancelled(status) {
  const value = String(status || "").trim().toLowerCase();
  return value === "cancelled" || value === "canceled";
}

function stampOf(transaction) {
  const raw = transaction.date ?? transaction.createdAt ?? transaction.created_at;
  if (raw == null || raw === "") return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function itemProductId(item) {
  if (item == null || typeof item !== "object") return null;
  if (item.productId != null && item.productId !== "") return item.productId;
  if (item.product_id != null && item.product_id !== "") return item.product_id;
  return null;
}

function itemQty(item) {
  if (item == null || typeof item !== "object") return null;
  return asNumber(item.qty ?? item.quantity);
}

function productName(product) {
  if (product.name != null && String(product.name).trim() !== "") return String(product.name);
  return `Product ${product.id}`;
}

function nonNegativeInt(value) {
  const number = asNumber(value);
  if (number == null || number <= 0) return 0;
  return Math.round(number);
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

function includesAny(text, words) {
  const value = String(text || "").toLowerCase();
  return words.some((word) => value.includes(word));
}

function blankToUndefined(value) {
  if (value == null) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}

module.exports = {
  buildAnalyticsForecast,
  regressionFromRequest,
  parseForecastYear,
};
