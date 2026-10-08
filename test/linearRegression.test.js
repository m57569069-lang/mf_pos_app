const test = require("node:test");
const assert = require("node:assert/strict");

const { fitLinearRegression, predict } = require("../lib/linearRegression");

function closeTo(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon,
    `expected ${expected} ± ${epsilon}, got ${actual}`
  );
}

test("learns an exact line and scores unseen x values from it", () => {
  const fit = fitLinearRegression([1, 2, 3], [2, 4, 6]);

  closeTo(fit.slope, 2);
  closeTo(fit.intercept, 0);
  closeTo(fit.rSquared, 1);
  closeTo(fit.mse, 0);
  assert.equal(fit.confidence, "high");
  assert.equal(fit.trend, "rising");
  assert.equal(fit.loss, "mean_squared_error");
  closeTo(predict(fit, 4), 8);
});

test("a flat series is a horizontal line with perfect fit", () => {
  const fit = fitLinearRegression([1, 2, 3, 4], [5, 5, 5, 5]);

  closeTo(fit.slope, 0);
  closeTo(fit.intercept, 5);
  closeTo(fit.rSquared, 1);
  assert.equal(fit.trend, "flat");
  closeTo(predict(fit, 12), 5);
});

test("identical inputs do not invent a slope", () => {
  const fit = fitLinearRegression([3, 3, 3], [4, 10, 16]);

  closeTo(fit.slope, 0);
  closeTo(fit.intercept, 10);
  closeTo(fit.rSquared, 0);
  assert.equal(fit.confidence, "low");
});

test("rejects mismatched training pairs", () => {
  assert.throws(
    () => fitLinearRegression([1, 2], [1]),
    RangeError
  );
});
