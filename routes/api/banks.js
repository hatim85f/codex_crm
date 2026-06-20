const express = require("express");

const router = express.Router();
const BankAccount = require("../../models/BankAccount");
const { auth, requireRole } = require("../../middleware/auth");

const INTERNAL = ["owner_admin", "admin", "sales", "marketing", "team_leader"];
const MANAGE = ["owner_admin", "admin"]; // manager/accountant level

router.use(auth);
router.use(requireRole(...INTERNAL));

const FIELDS = ["bankName", "accountHolderName", "accountNumber", "iban", "swift",
  "currency", "branch", "address", "notes", "isPrimary", "status"];

// GET /api/banks -> org bank accounts
router.get("/", async (req, res) => {
  try {
    const banks = await BankAccount.find({ organization: req.user.organization }).sort({ isPrimary: -1, createdAt: 1 });
    return res.json(banks);
  } catch (err) {
    console.error("list banks error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/banks
router.post("/", requireRole(...MANAGE), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.bankName) return res.status(400).json({ message: "Bank name is required" });
    if (b.isPrimary) {
      await BankAccount.updateMany({ organization: req.user.organization }, { isPrimary: false });
    }
    const doc = { organization: req.user.organization };
    FIELDS.forEach((f) => { if (b[f] !== undefined) doc[f] = b[f]; });
    const bank = await BankAccount.create(doc);
    return res.status(201).json(bank);
  } catch (err) {
    console.error("create bank error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

async function loadBank(req, res) {
  const bank = await BankAccount.findById(req.params.id);
  if (!bank || String(bank.organization) !== String(req.user.organization)) {
    res.status(404).json({ message: "Bank account not found" });
    return null;
  }
  return bank;
}

// PUT /api/banks/:id
router.put("/:id", requireRole(...MANAGE), async (req, res) => {
  try {
    const bank = await loadBank(req, res);
    if (!bank) return;
    const b = req.body || {};
    if (b.isPrimary && !bank.isPrimary) {
      await BankAccount.updateMany({ organization: req.user.organization }, { isPrimary: false });
    }
    FIELDS.forEach((f) => { if (b[f] !== undefined) bank[f] = b[f]; });
    await bank.save();
    return res.json(bank);
  } catch (err) {
    console.error("update bank error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/banks/:id
router.delete("/:id", requireRole(...MANAGE), async (req, res) => {
  try {
    const bank = await loadBank(req, res);
    if (!bank) return;
    await bank.deleteOne();
    return res.json({ ok: true, _id: bank._id });
  } catch (err) {
    console.error("delete bank error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
