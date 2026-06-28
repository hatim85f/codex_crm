// One-time (idempotent) backfill: posts COGS + fees Expenses for any existing
// eCommerce order profit records that were created before the ledger sync.
// Run:  node scripts/backfill-ecom-expenses.js
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const EcommerceOrderProfit = require("../models/EcommerceOrderProfit");
const User = require("../models/User");
const { syncOrderExpenses } = require("../services/ecomLedger");

(async () => {
  await connectDB();
  await new Promise((r) => setTimeout(r, 1200));
  const orders = await EcommerceOrderProfit.find({ isDeleted: false });
  console.log(`Found ${orders.length} order(s) to sync.`);
  for (const o of orders) {
    const owner = await User.findOne({ organization: o.organization, role: "owner_admin" }).select("_id");
    const userId = owner?._id || o.createdBy || null;
    const cogs = (o.productBuyingCost || 0) + (o.shippingCost || 0) + (o.courierDeliveryCost || 0) + (o.packingHandlingCost || 0);
    const fees = (o.paymentGatewayFee || 0) + (o.shopifyFee || 0);
    await syncOrderExpenses(o, userId);
    console.log(`  ${o.storeName}: COGS ${Math.round(cogs * 100) / 100} + fees ${Math.round(fees * 100) / 100} posted.`);
  }
  console.log("Backfill complete.");
  await mongoose.connection.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
