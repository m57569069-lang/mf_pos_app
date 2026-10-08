# Counter

Mobile sales and inventory for MF Electronics. Open it in a phone browser, sell from the counter, watch stock, and read a sales forecast learned with linear regression.

```bash
npm install
npm start
```

Then open http://localhost:3000. On a phone, use the same address on your network. The first launch loads a sample shop into `data/store.json` so the charts already have a year of tickets.

Set `DATABASE_URL` to use Postgres instead of the file. The sample shop is not loaded into Postgres. `DATA_FILE` overrides the JSON path.

## What you can do

- **Home** shows today's take, this month, a revenue trend, the top sellers, and what to restock.
- **Sell** builds a cart and records a paid ticket. Stock drops in the same step.
- **Stock** adds products and receives or removes units.
- **Insights** plots recorded months against a learned line and ranks top sellers by revenue or units.

## Linear regression

Forecasts are ordinary least squares. The model learns

`sales = intercept + slope × month`

by minimizing mean squared error on months that have already happened, including months with zero sales. Later months follow that line and are floored at zero. `R²` and a confidence label (`high`, `moderate`, `low`) say how well the line explains those months.

`GET /api/analytics/overview` is what the phone uses. It includes the revenue forecast, a forecast per product, top retail sellers, low stock, and reorder suggestions. Suggested reorder quantity is remaining forecast demand plus the reorder point, minus units on hand and outstanding purchase orders.

`GET /api/analytics/forecast?year=2026&productId=1` reads the same stored products, transactions, and purchase orders.

`POST /api/analytics/linear-regression` learns from numbers the device already has, without reading the database.

```json
{ "monthlyValues": [10, 60, 30, 40, 30, 80], "lastActualMonth": 6, "valueType": "units" }
```

`valueType` is `units` or `money`. Numbers after `lastActualMonth` are ignored, so placeholder zeros are not treated as real sales. Any x/y pairs can be sent the same way:

```json
{ "independent": [1, 2, 3], "dependent": [2, 4, 6], "predict": [4, 5] }
```

Void, cancelled, deleted, and unpaid tickets are excluded. Bulk, wholesale, corporate, and 100-unit tickets are left out of product unit forecasts and the top-seller ranking so one large order does not tilt the trend. Those tickets still count toward revenue.

## Other API routes

The Flutter client can keep using `/api/products`, `/api/transactions`, `/api/purchase-orders`, `/api/users`, and the related collections. The same routes are also mounted at the server root.

`POST /api/sales` is the counter checkout. It writes one transaction and decrements stock together.

```json
{ "items": [{ "productId": 2, "qty": 1 }], "payment": "Cash" }
```
