const jwt = require("jsonwebtoken");
const config = require("config");

const getSecret = () => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try {
    return config.get("jwtSecret");
  } catch (e) {
    return "mysecrettoken";
  }
};

const auth = (req, res, next) => {
  const header = req.header("Authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  const token = bearer || req.header("x-auth-token");

  if (!token) {
    return res.status(401).json({ message: "No token, authorization denied" });
  }

  try {
    const decoded = jwt.verify(token, getSecret());
    req.user = decoded; // { id, role }
    next();
  } catch (e) {
    return res.status(401).json({ message: "Token is not valid" });
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ message: "Forbidden: insufficient role" });
  }
  next();
};

module.exports = auth;
module.exports.auth = auth;
module.exports.requireRole = requireRole;
module.exports.getSecret = getSecret;
