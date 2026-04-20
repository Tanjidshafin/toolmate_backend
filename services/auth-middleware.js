const { verifyToken } = require('@clerk/clerk-sdk-node');

const normalizeEmail = (email) => {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed || null;
};

const toBearerToken = (authHeader = '') => {
  if (typeof authHeader !== 'string') return null;
  const [scheme, token] = authHeader.split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return token.trim() || null;
};

const extractEmailFromClaims = (claims = {}) => {
  const direct =
    claims.email ||
    claims.email_address ||
    claims.primary_email_address ||
    claims.primaryEmailAddress ||
    claims.user_primary_email_address;
  if (direct) return normalizeEmail(direct);

  const fromExtra = claims?.extra?.email || claims?.extra?.primary_email_address;
  if (fromExtra) return normalizeEmail(fromExtra);

  return null;
};

const resolveUserEmail = async ({ claims, usersStorage }) => {
  const fromClaims = extractEmailFromClaims(claims);
  if (fromClaims) return fromClaims;

  const userId = claims?.sub;
  if (!userId || !usersStorage) return null;

  try {
    const userDoc = await usersStorage.findOne(
      { clerkId: userId },
      { projection: { userEmail: 1 } },
    );
    if (userDoc?.userEmail) return normalizeEmail(userDoc.userEmail);
  } catch (error) {
    console.error('Failed to resolve user email from storage:', error?.message || error);
  }

  return null;
};

const createRequireAuth = ({ usersStorage }) => {
  const secretKey = process.env.CLERK_SECRET_KEY;

  return async (req, res, next) => {
    try {
      const token = toBearerToken(req.headers?.authorization);
      if (!token) {
        return res.status(401).json({ error: 'Unauthorized: missing bearer token' });
      }

      if (!secretKey) {
        console.error('CLERK_SECRET_KEY is not configured');
        return res.status(500).json({ error: 'Auth is not configured' });
      }

      const claims = await verifyToken(token, { secretKey });
      const userId = claims?.sub || null;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized: invalid token subject' });
      }

      const userEmail = await resolveUserEmail({ claims, usersStorage });

      req.authUser = {
        userId,
        userEmail,
        claims,
        token,
      };

      return next();
    } catch (error) {
      const message = error?.message || 'Token verification failed';
      return res.status(401).json({ error: `Unauthorized: ${message}` });
    }
  };
};

module.exports = {
  createRequireAuth,
  normalizeEmail,
};
