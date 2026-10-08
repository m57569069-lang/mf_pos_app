# mf_pos_app

Express API for the MF POS Flutter app.

## Sales forecast

Forecasts are ordinary least squares linear regression. The model learns

`y = intercept + slope * month`

by minimizing mean squared error on months that have already happened, including months with zero sales. Remaining months are that line, floored at zero.

`GET /api/analytics/forecast?year=2026&productId=4`

Reads products, transactions, and purchase orders already stored by the app. `year` and `productId` are optional.

`POST /api/analytics/linear-regression`

Learns from a series the device already has, without reading the database.

```json
{ "monthlyValues": [10, 60, 30, 40, 30, 80], "lastActualMonth": 6, "valueType": "units" }
```

`valueType` is `units` or `money`. Numbers after `lastActualMonth` are ignored, so placeholder zeros are not treated as real sales.

Any x/y pairs can be sent the same way:

```json
{ "independent": [1, 2, 3], "dependent": [2, 4, 6], "predict": [4, 5] }
```

Each series point has `actual`, `predicted`, `value`, and `isActual`. Plot `value` as a solid line where `isActual` is true and as a dashed line where it is false. `model.rSquared` and `model.confidence` (`high`, `moderate`, `low`) say how well the line explains the months it was trained on.
