/**
 * Univariate linear regression.
 *
 * The model learns h(x) = intercept + slope * x by minimizing mean squared
 * error on the training pairs. With one input, that minimum has a closed
 * form (ordinary least squares), so the slope and intercept returned here
 * are the exact learned line rather than an approximation.
 */

function fitLinearRegression(independent, dependent, options = {}) {
  if (!Array.isArray(independent) || !Array.isArray(dependent)) {
    throw new TypeError("Independent and dependent variables must be arrays.");
  }
  if (independent.length !== dependent.length) {
    throw new RangeError("Independent and dependent variable lengths must match.");
  }

  const n = independent.length;
  if (n === 0) {
    return emptyFit(options);
  }

  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += independent[i];
    sumY += dependent[i];
  }
  const xMean = sumX / n;
  const yMean = sumY / n;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    const dx = independent[i] - xMean;
    numerator += dx * (dependent[i] - yMean);
    denominator += dx * dx;
  }

  // Identical x values leave the slope unidentified. The least-squares
  // choice is a horizontal line through the mean of y.
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = yMean - slope * xMean;

  let sse = 0;
  let sst = 0;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * independent[i];
    const residual = dependent[i] - predicted;
    sse += residual * residual;
    const centered = dependent[i] - yMean;
    sst += centered * centered;
  }

  // A constant series is explained perfectly by the horizontal line.
  const rSquared = sst === 0 ? 1 : clamp01(1 - sse / sst);
  const mse = sse / n;

  return {
    slope,
    intercept,
    rSquared,
    mse,
    rmse: Math.sqrt(mse),
    n,
    mean: yMean,
    confidence: confidenceFromRSquared(rSquared),
    trend: trendOf(slope, yMean),
    equation: formatEquation(intercept, slope, options.variableName || "x"),
    loss: "mean_squared_error",
  };
}

function predict(model, x) {
  return model.intercept + model.slope * x;
}

function confidenceFromRSquared(rSquared) {
  if (rSquared >= 0.6) return "high";
  if (rSquared >= 0.3) return "moderate";
  return "low";
}

function emptyFit(options = {}) {
  return {
    slope: 0,
    intercept: 0,
    rSquared: 0,
    mse: 0,
    rmse: 0,
    n: 0,
    mean: 0,
    confidence: "low",
    trend: "flat",
    equation: formatEquation(0, 0, options.variableName || "x"),
    loss: "mean_squared_error",
  };
}

function trendOf(slope, yMean) {
  const band = Math.max(Math.abs(yMean) * 0.02, 1e-6);
  if (slope > band) return "rising";
  if (slope < -band) return "falling";
  return "flat";
}

function formatEquation(intercept, slope, variableName) {
  const sign = slope < 0 ? "-" : "+";
  return `y = ${formatCoef(intercept)} ${sign} ${formatCoef(Math.abs(slope))} * ${variableName}`;
}

function formatCoef(value) {
  const rounded = Math.round(value * 1000) / 1000;
  if (rounded === 0) return "0";
  return String(rounded);
}

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

module.exports = {
  fitLinearRegression,
  predict,
  confidenceFromRSquared,
};
