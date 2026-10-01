const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("mf_pos_app is running");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on port " + PORT);
});
