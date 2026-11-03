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

/**
 * User Registration (Sign Up)
 */
function registerUser(username, password, role = 'Pharmacist') {
  if (!username || !password) {
    return { success: false, error: 'MISSING_FIELDS', message: 'Username and password are required.' };
  }

  if (password.length < 6) {
    return { success: false, error: 'PASSWORD_TOO_SHORT', message: 'Password must be at least 6 characters long.' };
  }

  const validRoles = ['Admin', 'Pharmacist', 'Inspector'];
  if (!validRoles.includes(role)) {
    return { success: false, error: 'INVALID_ROLE', message: `Role must be one of: ${validRoles.join(', ')}` };
  }

  const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existingUser) {
    return { success: false, error: 'USERNAME_TAKEN', message: 'Username already taken. Please choose another.' };
  }

  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(password, salt);

  const insertStmt = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)');
  const info = insertStmt.run(username, passwordHash, role);

  const user = {
    id: info.lastInsertRowid,
    username,
    role
  };

  const token = jwt.sign(user, config.JWT_SECRET, { expiresIn: '24h' });

  // Asynchronously mirror new user to Supabase
  try {
    const { supabase } = require('./supabaseClient');
    if (supabase) {
      supabase.from('users').insert({
        username,
        password_hash: passwordHash,
        role
      }).then(({ error }) => {
        if (error) console.error('[Supabase Mirror] User register error:', error.message);
      });
    }
  } catch (err) {}

  return {
    success: true,
    token,
    user
  };
}

module.exports = {
  loginUser,
  registerUser,
  authenticateToken,
  requireRoles
};
