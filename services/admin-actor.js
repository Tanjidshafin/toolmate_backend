const DEFAULT_ADMIN_ROLE = 'admin';
const DEFAULT_ADMIN_USERNAME = 'admin';

const normalizeRole = (role) => String(role || DEFAULT_ADMIN_ROLE).toLowerCase();

const getAdminActorFromRequest = (req) => {
  const userEmail = String(req?.headers?.['x-admin-user-email'] || '').trim();
  const role = normalizeRole(req?.headers?.['x-admin-role']);
  const username = String(req?.headers?.['x-admin-username'] || DEFAULT_ADMIN_USERNAME).trim() || DEFAULT_ADMIN_USERNAME;

  return {
    userId: userEmail || 'unknown-admin',
    userEmail: userEmail || 'unknown-admin',
    role,
    username,
  };
};

module.exports = {
  getAdminActorFromRequest,
};
