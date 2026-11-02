const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./database');
const config = require('./config');

/**
 * User Login
 */
function loginUser(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    return { success: false, error: 'INVALID_CREDENTIALS', message: 'Invalid username or password' };
  }

  const isPasswordValid = bcrypt.compareSync(password, user.password_hash);
  if (!isPasswordValid) {
    return { success: false, error: 'INVALID_CREDENTIALS', message: 'Invalid username or password' };
  }

  const token = jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role
    },
    config.JWT_SECRET,
    { expiresIn: '24h' }
  );

  return {
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role
    }
  };
}

/**
 * Express Middleware: Authenticate JWT Token
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Format: "Bearer <token>"

  if (!token) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Access token required.'
    });
  }

  jwt.verify(token, config.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Invalid or expired access token.'
      });
    }

    req.user = decoded;
    next();
  });
}

/**
 * Express Middleware: Require Specific Role(s)
 * Enforces server-side permissions for Admin, Pharmacist, and Inspector.
 */
function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'INSUFFICIENT_PERMISSIONS',
        message: `Action requires one of the following roles: [${allowedRoles.join(', ')}]. Your role: ${req.user ? req.user.role : 'none'}`
      });
    }
    next();
  };
}

module.exports = {
  loginUser,
  authenticateToken,
  requireRoles
};
