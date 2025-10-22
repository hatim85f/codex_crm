const jwt = require("jsonwebtoken");
const config = require("config");

module.exports = (req, res, next) => {
  const secretToken =
    process.env.NODE_ENV === "production"
      ? process.env.JWT_SECRET
      : config.get("jwtSecret");

  // Get token from header
  const token = req.header("x-auth-token");

  // check if no Token
  if (!token) {
    return res.status(401).json({
      message:
        "You are not authorized to perform this operation, login or contact your provider",
    });
  }

  // verify token

  try {
    const decoded = jwt.verify(token, secretToken);

    req.user = decoded.user;
    next();
  } catch (error) {
    res.status(401).json({ message: error.message });
  }
};
